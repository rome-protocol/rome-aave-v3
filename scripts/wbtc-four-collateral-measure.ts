// Read-only gate for listing wBTC: with FOUR active collaterals, does every priced Aave action still fit
// what the Rome proxy accepts? For a user that holds wUSDC, wETH, wSOL and wBTC supplied as collateral and
// has some debt, it measures, per asset:
//   borrow               (borrow ~$USD_AMOUNT of the asset)
//   withdraw-with-debt   (withdraw ~$USD_AMOUNT of the asset, capped at the user's balance)
//   liquidationCall      (debtToCover = max-uint: the whole debt of that asset, or all of collateral c;
//                         collateral = each of the four assets, debt = each asset the liquidatee owes)
// and prints eth_call status, eth_estimateGas and the Solana account count from the proxy's
// rome_emulateCallAccounts [tx, payerBase58] (count = length of the returned account list). Nothing is sent,
// no key is needed.
//
// The limit that matters is the PROXY's, not Solana's raw 64. The Rome-EVM SDK counts the emulated accounts
// + 1 and rejects above 63 ("Too many accounts: 65, maximum allowed is 63" from eth_estimateGas). So the
// hard ceiling for the emulate count is 62 (LIMIT default), and a row whose estimateGas returns that error
// is a FAIL whatever the emulate count says. 60 is the safety margin.
//
//   MEASURE_USER=0x<4-collateral borrower> MEASURE_PAYER=<base58 Solana wallet> \
//     ACTIONS=borrow,withdraw npx hardhat run scripts/wbtc-four-collateral-measure.ts
//
// Env:
//   MEASURE_USER        required. Holds all four assets as enabled collateral and has debt (EVM lane: the EOA).
//   MEASURE_PAYER       required. A REAL, funded Solana wallet (base58). The default system-program payer
//                       errors ("could not coalesce error"), so it is refused here.
//   ACTIONS             comma list of borrow, withdraw, liquidation (default: all three). Run
//                       ACTIONS=borrow,withdraw while the borrower is healthy (HF >= 1) and ACTIONS=liquidation
//                       while HF < 1, so each run's RESULT and exit code mean something.
//   MEASURE_LIQUIDATOR  address that calls liquidationCall (default: the deployer in hadrian-oracle-shims.json).
//                       It must hold the FULL debt of the debt asset (max-uint repays all of it) and have
//                       signed approve_spl on that wrapper.
//   MEASURE_LIQUIDATEE  borrower to liquidate (default: MEASURE_USER). Debts are read from the liquidatee.
//   USD_AMOUNT          size of each borrow / withdraw row in USD (default 1).
//   LIMIT / MARGIN      emulate-count limits to judge against (default 62 / 60).
//   RPC_URL             default Hadrian.
//
// How a row is judged. An emulation that reverts still returns the accounts touched up to the revert, so
// that count is only a LOWER BOUND. Each row therefore also does an eth_call and an eth_estimateGas:
//   FAIL      estimateGas says "Too many accounts: N, maximum allowed is M", or accounts > limit
//   INVALID   the call reverts and no FAIL evidence: the count is partial, do not trust it
//   PASS      the call succeeds, accounts <= limit, estimateGas succeeds
//   PASS*     same, but estimateGas failed with a NON-account error (e.g. the proxy's ~1.25M atomic pad):
//             counted as PASS, listed under CHECK BY HAND
// liquidationCall only runs to the end when the borrower's health factor is below 1, borrow / withdraw only
// while it is above 1. A run whose ACTIONS do not match the health factor reports a precondition.
// Exit code: 0 all rows PASS at the limit, 1 any FAIL, 2 no FAIL but something INVALID / precondition missing.
import { ethers } from "ethers";
import { loadDeployments, loadShims, readJson, usd } from "./lib/oracle-common.js";
import { env, RPC_URL, DATA_PROVIDER_ABI } from "./lib/listing-common.js";

const POOL_ABI = [
  "function getReservesList() view returns (address[])",
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function withdraw(address,uint256,address) returns (uint256)",
  "function liquidationCall(address,address,address,uint256,bool)",
];
const DP_USER_ABI = [
  ...DATA_PROVIDER_ABI,
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
];
const ERC20_ABI = ["function decimals() view returns (uint8)"];
const ORACLE_ABI = ["function getAssetPrice(address) view returns (uint256)"];
const WANT = ["wUSDC", "wETH", "wSOL", "wBTC"];

type Row = {
  action: string; detail: string; call: string; gas: string; accounts: number | null; err?: string;
  sdk?: { n: number; m: number }; gasErr?: string;
};
const SDK_RE = /Too many accounts: (\d+), maximum allowed is (\d+)/;

async function main() {
  const user = env("MEASURE_USER");
  if (!ethers.isAddress(user)) throw new Error("set MEASURE_USER=0x... (a borrower holding all four assets as collateral, with debt)");
  const payer = env("MEASURE_PAYER");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payer) || /^1+$/.test(payer))
    throw new Error("set MEASURE_PAYER=<base58 of a real, funded Solana wallet>; the system-program default errors");
  const limit = Number(env("LIMIT", "62")), margin = Number(env("MARGIN", "60"));
  const usdAmount = env("USD_AMOUNT", "1");
  const actions = env("ACTIONS", "borrow,withdraw,liquidation").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const a of actions) if (!["borrow", "withdraw", "liquidation"].includes(a)) throw new Error(`ACTIONS: unknown "${a}" (borrow, withdraw, liquidation)`);
  const want = (a: string) => actions.includes(a);
  const liquidator = env("MEASURE_LIQUIDATOR", readJson("deployments/hadrian-oracle-shims.json").deployer);
  const victim = env("MEASURE_LIQUIDATEE", user);
  for (const [k, v] of [["MEASURE_LIQUIDATOR", liquidator], ["MEASURE_LIQUIDATEE", victim]]) if (!ethers.isAddress(v)) throw new Error(`${k} is not an address: ${v}`);

  const dep = loadDeployments();
  const provider = new ethers.JsonRpcProvider(RPC_URL());
  const pool = new ethers.Contract(dep.Pool.address, POOL_ABI, provider);
  const dp = new ethers.Contract(dep.AaveProtocolDataProvider.address, DP_USER_ABI, provider);
  const oracle = new ethers.Contract(dep.AaveOracle.address, ORACLE_ABI, provider);
  const iface = pool.interface;

  // The four assets, by symbol: _reserves for the three live ones, the shims record for wBTC until it is in _reserves.
  const known: Record<string, string> = {};
  for (const [s, r] of Object.entries<any>(dep._reserves ?? {})) known[s] = r.asset;
  try { for (const [s, e] of Object.entries(loadShims())) if (!known[s]) known[s] = e.asset; } catch { /* no shims record */ }
  const listed = new Set<string>((await pool.getReservesList()).map((a: string) => a.toLowerCase()));
  const assets: Record<string, string> = {};
  const pre: string[] = [];
  for (const s of WANT) {
    if (!known[s]) { pre.push(`${s}: address unknown (not in deployments/hadrian.json _reserves or the shims record)`); continue; }
    if (!listed.has(known[s].toLowerCase())) { pre.push(`${s}: not a listed reserve of Pool ${dep.Pool.address} yet`); continue; }
    assets[s] = ethers.getAddress(known[s]);
  }
  const syms = Object.keys(assets);

  const dec: Record<string, number> = {}, px: Record<string, bigint> = {};
  for (const s of syms) {
    dec[s] = Number(await new ethers.Contract(assets[s], ERC20_ABI, provider).decimals());
    px[s] = await oracle.getAssetPrice(assets[s]);
  }
  // ~usdAmount worth of `s`, rounded up to at least 1 base unit.
  const worth = (s: string): bigint => {
    const u = (ethers.parseUnits(usdAmount, 8) * 10n ** BigInt(dec[s])) / px[s];
    return u > 0n ? u : 1n;
  };

  console.log(`Pool ${dep.Pool.address}  user ${user}  payer ${payer}`);
  console.log(`liquidator ${liquidator}  liquidatee ${victim}  action size ~$${usdAmount}  actions ${actions.join(",")}  limits ${limit} (hard) / ${margin} (margin)\n`);

  // Position of the measured user, and of the liquidatee.
  const pos: Record<string, { bal: bigint; debt: bigint; coll: boolean }> = {};
  console.log("asset   price        supplied(aToken)  collateral  debt(variable)");
  for (const s of syms) {
    const d = await dp.getUserReserveData(assets[s], user);
    pos[s] = { bal: d.currentATokenBalance, debt: d.currentVariableDebt, coll: d.usageAsCollateralEnabled };
    console.log(`${s.padEnd(7)} ${usd(px[s]).padEnd(12)} ${ethers.formatUnits(pos[s].bal, dec[s]).padEnd(17)} ${String(pos[s].coll).padEnd(11)} ${ethers.formatUnits(pos[s].debt, dec[s])}`);
    if (!(pos[s].bal > 0n && pos[s].coll)) pre.push(`${s}: ${user} does not hold it as enabled collateral (balance ${pos[s].bal}, enabled ${pos[s].coll})`);
  }
  if ((want("borrow") || want("withdraw")) && !syms.some((s) => pos[s].debt > 0n)) pre.push(`${user} has no debt`);
  const acct = await pool.getUserAccountData(victim);
  const hf = acct.healthFactor as bigint;
  const hfTxt = hf > 10n ** 30n ? "no debt" : (Number(hf) / 1e18).toFixed(4);
  console.log(`\nliquidatee ${victim}: health factor ${hfTxt}${hf >= 10n ** 18n ? "  (>= 1: not liquidatable)" : "  (< 1: liquidatable)"}\n`);
  const userHf = victim.toLowerCase() === user.toLowerCase() ? hf : ((await pool.getUserAccountData(user)).healthFactor as bigint);
  if (want("liquidation") && hf >= 10n ** 18n) pre.push(`liquidation selected but the liquidatee's health factor is >= 1: every liquidation row would revert (run it at HF < 1)`);
  if ((want("borrow") || want("withdraw")) && userHf < 10n ** 18n) pre.push(`borrow / withdraw selected but ${user}'s health factor is < 1: those rows would revert (run them at HF >= 1)`);

  const rows: Row[] = [];
  const measure = async (action: string, detail: string, from: string, data: string) => {
    const tx = { from, to: dep.Pool.address, data };
    const r: Row = { action, detail, call: "ok", gas: "n/a", accounts: null };
    try { await provider.call(tx); } catch (e: any) { r.call = `reverts (${(e.shortMessage ?? e.message ?? "").slice(0, 60)})`; }
    try { r.gas = (await provider.estimateGas(tx)).toString(); }
    catch (e: any) {
      const msg = String(e.info?.error?.message ?? e.shortMessage ?? e.message ?? e);
      r.gasErr = msg.slice(0, 120);
      const m = SDK_RE.exec(msg) ?? SDK_RE.exec(String(e.message ?? ""));
      if (m) { r.sdk = { n: Number(m[1]), m: Number(m[2]) }; r.gas = `${m[1]}/${m[2]}`; } else r.gas = "error";
    }
    try { r.accounts = ((await provider.send("rome_emulateCallAccounts", [tx, payer])) as unknown[]).length; }
    catch (e: any) { r.err = (e.shortMessage ?? e.message ?? "error").slice(0, 80); }
    rows.push(r);
  };

  if (want("borrow")) for (const s of syms) await measure("borrow", s, user, iface.encodeFunctionData("borrow", [assets[s], worth(s), 2, 0, user]));
  if (want("withdraw")) for (const s of syms) {
    const amt = pos[s].bal > 0n && pos[s].bal < worth(s) ? pos[s].bal : worth(s);
    await measure("withdraw-with-debt", s, user, iface.encodeFunctionData("withdraw", [assets[s], amt, user]));
  }
  if (want("liquidation")) {
    if (victim.toLowerCase() === liquidator.toLowerCase()) pre.push(`MEASURE_LIQUIDATOR equals the liquidatee: a self-liquidation shares accounts, so the liquidation counts are lower than a third party's. Use a different liquidator`);
    // Debts are read from the liquidatee. debtToCover = max-uint: Aave then repays the whole debt of that asset (100% close
    // factor under $2000 of debt/collateral, or HF < 0.95), or takes all of collateral c, and skips the MustNotLeaveDust check
    // that a ~$1 partial liquidation would trip. The liquidator needs the full debt of the asset in its wallet.
    const vdebt: Record<string, bigint> = {};
    for (const s of syms) vdebt[s] = victim.toLowerCase() === user.toLowerCase() ? pos[s].debt : (await dp.getUserReserveData(assets[s], victim)).currentVariableDebt;
    const debtAssets = syms.filter((s) => vdebt[s] > 0n);
    if (victim.toLowerCase() !== user.toLowerCase()) console.log(`note: MEASURE_LIQUIDATEE differs from MEASURE_USER; liquidation debts are read from the liquidatee: ${debtAssets.join(", ") || "none"}`);
    if (!debtAssets.length) pre.push(`liquidatee ${victim} has no debt`);
    for (const d of debtAssets) for (const c of syms) {
      await measure("liquidationCall", `coll ${c} / debt ${d}`, liquidator, iface.encodeFunctionData("liquidationCall", [assets[c], assets[d], victim, ethers.MaxUint256, false]));
    }
  }
  if (!rows.length) {
    console.log("NO ROWS MEASURED. PRECONDITIONS NOT MET:");
    for (const p of pre) console.log(`  - ${p}`);
    console.log(`RESULT [${actions.join(",")}]: INVALID`);
    process.exit(2);
  }

  // Verdicts. The proxy's own ceiling (sdk max - 1) can lower the hard limit.
  const sdkMax = rows.reduce<number | null>((m, r) => (r.sdk ? (m === null ? r.sdk.m : Math.min(m, r.sdk.m)) : m), null);
  const hard = sdkMax !== null ? Math.min(limit, sdkMax - 1) : limit;
  const verdict = (r: Row, lim: number): "PASS" | "FAIL" | "INVALID" => {
    if (r.sdk) return "FAIL";
    if (r.accounts === null) return "INVALID";
    if (r.accounts > lim) return "FAIL";
    return r.call === "ok" ? "PASS" : "INVALID";
  };
  const hand = (r: Row) => r.call === "ok" && !r.sdk && r.gasErr !== undefined;
  const w = (s: string, n: number) => s.padEnd(n);
  console.log(`${w("action", 19)}${w("asset", 26)}${w("eth_call", 10)}${w("estimateGas", 13)}${w("accounts", 9)}${w(`vs ${hard}`, 9)}vs ${margin}`);
  for (const r of rows) {
    const acc = r.accounts === null ? `error` : String(r.accounts) + (r.call === "ok" ? "" : "+");
    const v = verdict(r, hard) + (verdict(r, hard) === "PASS" && hand(r) ? "*" : "");
    console.log(`${w(r.action, 19)}${w(r.detail, 26)}${w(r.call === "ok" ? "ok" : "reverts", 10)}${w(r.gas, 13)}${w(acc, 9)}${w(v, 9)}${verdict(r, margin)}${r.err ? `   [${r.err}]` : ""}${r.call !== "ok" ? `   [${r.call}]` : ""}`);
  }
  console.log(`("+" = the call reverts, so the count is a lower bound. estimateGas "N/M" = the SDK's own count N against its maximum M: FAIL.)`);
  const byHand = rows.filter((r) => verdict(r, hard) === "PASS" && hand(r));
  if (byHand.length) {
    console.log(`CHECK BY HAND (PASS*): eth_call ok and the count fits, but estimateGas failed for another reason, e.g. the proxy's ~1.25M atomic estimate pad while a real send fits ~1.35M:`);
    for (const r of byHand) console.log(`  ${r.action} ${r.detail}: ${r.gasErr}`);
  }
  console.log("");

  const max = rows.reduce((m, r) => Math.max(m, r.accounts ?? 0), 0);
  const overall = (lim: number) => {
    const vs = rows.map((r) => verdict(r, lim));
    if (vs.includes("FAIL")) return "FAIL";
    return pre.length || vs.includes("INVALID") ? "INVALID" : "PASS";
  };
  if (pre.length) { console.log("PRECONDITIONS NOT MET:"); for (const p of pre) console.log(`  - ${p}`); console.log(""); }
  const oHard = overall(hard), oMargin = overall(margin);
  console.log(`MAX accounts over all rows: ${max}   (SDK ceiling: ${sdkMax === null ? "not reported by this run; 63 today, so <= 62 here" : `${sdkMax} => <= ${sdkMax - 1} here`})`);
  console.log(`RESULT [${actions.join(",")}] vs ${hard}: ${oHard}`);
  console.log(`RESULT [${actions.join(",")}] vs ${margin}: ${oMargin}`);
  process.exit(oHard === "PASS" ? 0 : oHard === "FAIL" ? 1 : 2);
}
main().catch((e) => { console.error(e); process.exit(1); });
