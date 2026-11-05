// Read-only: what do the priced Aave actions cost from a given address, right now? Run it before and
// after scripts/switch-oracle-to-book.ts and compare. For borrow, withdraw (with debt) and
// liquidationCall it prints eth_estimateGas and the Solana account count from the proxy's
// rome_emulateCallAccounts [tx, payerBase58] (returns the account list; count = its length).
// No key and no writes needed:
//   MEASURE_USER=0x... [MEASURE_LIQUIDATEE=0x...] npx hardhat run scripts/measure-price-cost.ts
// Reading the numbers: eth_estimateGas on Rome is Rome gas (lamport-scale per-leg fees plus EVM gas), NOT
// Solana CU, and atomic calls often floor at 21000, so it cannot show the price read's CU. CU needs
// computeUnitsConsumed from the receipts of real sends on both lanes. The account count is the useful number.
// Lanes: EVM lane = MEASURE_USER is the EOA; Solana lane = MEASURE_USER is the user's synthetic EVM address and
// MEASURE_PAYER is that Solana wallet (base58). Keep the same payer before and after the switch.
// Optional env: RPC_URL, MEASURE_PAYER (base58, default system program), BORROW_ASSET (wUSDC), BORROW_AMOUNT (0.1),
// WITHDRAW_ASSET (wETH), WITHDRAW_AMOUNT (0.0001), LIQ_COLLATERAL (wETH), LIQ_DEBT (wUSDC), LIQ_AMOUNT (0.1).
import { ethers } from "ethers";
import { loadDeployments, usd } from "./lib/oracle-common.js";

const env = (k: string, d = "") => process.env[k] || d;

async function main() {
  const user = env("MEASURE_USER");
  if (!ethers.isAddress(user)) throw new Error("set MEASURE_USER=0x... (the address to measure from)");
  const dep = loadDeployments();
  const provider = new ethers.JsonRpcProvider(env("RPC_URL", "https://hadrian.testnet.romeprotocol.xyz/"));
  const payer = env("MEASURE_PAYER", "11111111111111111111111111111111");
  const poolAddr: string = dep.Pool.address;
  const pool = new ethers.Interface([
    "function borrow(address,uint256,uint256,uint16,address)",
    "function withdraw(address,uint256,address) returns (uint256)",
    "function liquidationCall(address,address,address,uint256,bool)",
  ]);
  const oracle = new ethers.Contract(dep.AaveOracle.address, ["function getAssetPrice(address) view returns (uint256)", "function getSourceOfAsset(address) view returns (address)"], provider);
  const addr = (sym: string): string => { const a = dep._reserves?.[sym]?.asset; if (!a) throw new Error(`unknown reserve ${sym}`); return a; };
  const amt = async (sym: string, h: string) => ethers.parseUnits(h, Number(await new ethers.Contract(addr(sym), ["function decimals() view returns (uint8)"], provider).decimals()));

  console.log(`Pool ${poolAddr} from ${user}`);
  for (const s of Object.keys(dep._reserves ?? {}))
    console.log(`  oracle ${s}: ${usd(await oracle.getAssetPrice(addr(s)))} source=${await oracle.getSourceOfAsset(addr(s))}`);

  const calls: Record<string, string | null> = {};
  const bA = env("BORROW_ASSET", "wUSDC"), wA = env("WITHDRAW_ASSET", "wETH"), lC = env("LIQ_COLLATERAL", "wETH"), lD = env("LIQ_DEBT", "wUSDC");
  calls.borrow = pool.encodeFunctionData("borrow", [addr(bA), await amt(bA, env("BORROW_AMOUNT", "0.1")), 2, 0, user]);
  calls["withdraw-with-debt"] = pool.encodeFunctionData("withdraw", [addr(wA), await amt(wA, env("WITHDRAW_AMOUNT", "0.0001")), user]);
  const victim = env("MEASURE_LIQUIDATEE");
  calls.liquidationCall = victim ? pool.encodeFunctionData("liquidationCall", [addr(lC), addr(lD), victim, await amt(lD, env("LIQ_AMOUNT", "0.1")), false]) : null;

  for (const [name, data] of Object.entries(calls)) {
    if (!data) { console.log(`${name}: skipped (set MEASURE_LIQUIDATEE=<borrower below HF 1>)`); continue; }
    const tx = { from: user, to: poolAddr, data };
    let gas = "n/a", accounts = "n/a";
    try { gas = (await provider.estimateGas(tx)).toString(); } catch (e: any) { gas = `reverts (${e.shortMessage ?? e.message})`; }
    try { accounts = String(((await provider.send("rome_emulateCallAccounts", [{ ...tx, from: user }, payer])) as unknown[]).length); } catch (e: any) { accounts = `error (${e.shortMessage ?? e.message})`; }
    console.log(`${name}: eth_estimateGas=${gas} accounts(rome_emulateCallAccounts, payer ${payer})=${accounts}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
