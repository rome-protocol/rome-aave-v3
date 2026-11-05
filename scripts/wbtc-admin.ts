// Pool-admin calls for listing and unwinding the wBTC reserve, signed by the hardhat
// keystore key (HADRIAN_PRIVATE_KEY), so no key is ever put in a shell variable or on a command line.
//
//   ACTION=<name> [ASSET=wBTC] [PRICE_USD=<n>] npx hardhat run scripts/wbtc-admin.ts --network hadrian
//
// ACTION:
//   borrow-off     PoolConfigurator.setReserveBorrowing(asset, false)
//   ltv-zero       PoolConfigurator.configureReserveAsCollateral(asset, 0, <threshold>, <bonus>)   (7500 / 10500 for wBTC)
//   drop           PoolConfigurator.dropReserve(asset)             (reverts while aToken / vToken supply is not 0)
//   withdraw-all   Pool.withdraw(asset, max-uint, <signer>)  the signer's whole supply of the asset (unwind before drop;
//                  in a dry run it is previewed for FROM, so set FROM=<the supplier> to preview another wallet)
//   price-mock     deploy a MockAggregator at PRICE_USD and AaveOracle.setAssetSources([asset],[mock])   (price window)
//   price-book     AaveOracle.setAssetSources([asset],[PriceBook shim])   (end of the window). The record follows
//                  ORACLE_SHIMS like switch-oracle-to-book.ts, but defaults to "lean" (hadrian-oracle-lean-shims.json,
//                  the shims AaveOracle uses today); ORACLE_SHIMS=book picks hadrian-oracle-shims.json.
//
// Why not setReserveFreeze: in Aave v3.6 it loops over all 255 eMode categories and the proxy refuses it
// ("Too many accounts: 276, maximum allowed is 63"), even though eth_call passes. Borrowing off + LTV 0 + the
// caps bound the reserve instead.
//
// DRY_RUN=1 sends nothing and needs no key. It prints the transaction and runs eth_call AND eth_estimateGas
// from FROM (default: the deployer in hadrian-oracle-shims.json). eth_call alone does not apply the account
// limit, estimateGas does. price-mock cannot deploy in a dry run: it previews setAssetSources with the PriceBook shim.
// Exit code in a dry run: 0 both checks ok, 2 any check failed.
import { ethers } from "ethers";
import { loadDeployments, loadSwitchTargets, readJson } from "./lib/oracle-common.js";
import { env, RPC_URL, resolveAsset, preflight } from "./lib/listing-common.js";

// AaveOracle's wBTC source is the lean shim, so restoring it must not point back at the heavier adapter shim.
process.env.ORACLE_SHIMS ??= "lean";

const CFG_ABI = [
  "function setReserveBorrowing(address asset, bool enabled)",
  "function configureReserveAsCollateral(address asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)",
  "function dropReserve(address asset)",
];
const POOL_ABI = ["function withdraw(address asset, uint256 amount, address to) returns (uint256)"];
const ORACLE_ABI = ["function setAssetSources(address[] assets, address[] sources)"];
const ACTIONS = ["borrow-off", "ltv-zero", "drop", "withdraw-all", "price-mock", "price-book"];

async function main() {
  const action = env("ACTION");
  if (!ACTIONS.includes(action)) throw new Error(`set ACTION=${ACTIONS.join(" | ")}`);
  const { symbol, address: asset } = resolveAsset(env("ASSET", "wBTC"));
  const dryRun = /^(1|true|yes)$/i.test(env("DRY_RUN"));
  const dep = loadDeployments();
  const provider = new ethers.JsonRpcProvider(RPC_URL());
  const cfgAddr: string = dep.PoolConfigurator.address, oracleAddr: string = dep.AaveOracle.address;
  const cfg = new ethers.Interface(CFG_ABI), orc = new ethers.Interface(ORACLE_ABI);
  const shim = (() => { try { return loadSwitchTargets()[symbol]?.shim as string | undefined; } catch { return undefined; } })();

  // wBTC's own risk parameters, the planned values (read from the reserve when it is listed).
  const reserve = dep._reserves?.[symbol];
  const thr = BigInt(reserve?.liquidationThreshold ?? 7500), bonus = BigInt(reserve?.liquidationBonus ?? 10500);

  const from0 = env("FROM", readJson("deployments/hadrian-oracle-shims.json").deployer);
  let to = cfgAddr, data = "", label = action;
  if (action === "borrow-off") data = cfg.encodeFunctionData("setReserveBorrowing", [asset, false]);
  else if (action === "ltv-zero") data = cfg.encodeFunctionData("configureReserveAsCollateral", [asset, 0, thr, bonus]);
  else if (action === "drop") data = cfg.encodeFunctionData("dropReserve", [asset]);
  else if (action === "withdraw-all") {
    to = dep.Pool.address;
    // the recipient is the signer; in a dry run, FROM
    data = "";
  }
  else {
    to = oracleAddr;
    if (action === "price-book" || dryRun) {
      if (!shim) throw new Error(`no PriceBook shim for ${symbol} in the ${process.env.ORACLE_SHIMS} shims record`);
      data = orc.encodeFunctionData("setAssetSources", [[asset], [shim]]);
    }
  }

  console.log(`${action} ${symbol} ${asset}  -> ${to}`);
  if (dryRun) {
    const from = from0;
    if (action === "withdraw-all") data = new ethers.Interface(POOL_ABI).encodeFunctionData("withdraw", [asset, ethers.MaxUint256, from]);
    if (!ethers.isAddress(from)) throw new Error(`FROM is not an address: ${from}`);
    console.log(`DRY RUN, nothing is sent. from ${from}${action === "price-mock" ? " (previews setAssetSources with the PriceBook shim; the mock is deployed only in a real run)" : ""}`);
    console.log(`  would send ${label}: to ${to} data ${data}`);
    const r = await preflight(provider, { from, to, data });
    console.log(`    ${r.text}`);
    process.exit(r.ok ? 0 : 2);
  }

  // Real run: the hardhat network signer (keystore HADRIAN_PRIVATE_KEY). Imported here so a dry run never loads a key.
  const hre = (await import("hardhat")).default;
  const { ethers: hEthers } = await hre.network.connect();
  const [signer] = await hEthers.getSigners();
  console.log(`signer ${signer.address}`);
  if (action === "withdraw-all") data = new ethers.Interface(POOL_ABI).encodeFunctionData("withdraw", [asset, ethers.MaxUint256, signer.address]);
  if (action === "price-mock") {
    const usdIn = env("PRICE_USD");
    if (!/^\d+(\.\d+)?$/.test(usdIn)) throw new Error("set PRICE_USD=<usd price of 1 whole token, e.g. 61000>");
    const price = BigInt(Math.round(parseFloat(usdIn) * 1e8));
    const mock = await (await hEthers.getContractFactory("MockAggregator")).deploy(price);
    await mock.waitForDeployment();
    const agg = await mock.getAddress();
    console.log(`MockAggregator @ $${usdIn}: ${agg}`);
    data = orc.encodeFunctionData("setAssetSources", [[asset], [agg]]);
  }
  const tx = await signer.sendTransaction({ to, data });
  console.log(`${action} tx ${tx.hash}`);
  await tx.wait();
  console.log(`${action}: done`);
}
main().catch((e) => { console.error(e); process.exit(1); });
