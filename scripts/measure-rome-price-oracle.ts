// Read-only: how many Solana accounts does RomePriceOracle save versus AaveOracle? Uses the proxy's
// rome_emulateCallAccounts [tx, payerBase58] (count = length of the returned account list). No key, no writes.
//   (a) AaveOracle.getAssetPrice(asset)        the previous path: AaveOracle -> source (lean shim) -> PriceBook entry
//   (a3) AaveOracle.getAssetsPrices([k assets]) the same path for k prices in one call
//   (c) PriceBook.entryOf(sourceAccount)        the ONE external call RomePriceOracle makes per price
// RomePriceOracle is the pool's price oracle now; its read is ESTIMATED here as (c) + 1: the book read plus the oracle's own
// contract account (everything else is immutable bytecode: no storage account, no per-asset contract). Each
// emulation is a top-level call, so it also carries the call's fixed accounts (payer, system program, Rome
// programs); those cancel in the differences. For k prices the union of the direct-read account sets is used
// (the fixed accounts and the PriceBook are shared), plus the one oracle account.
// Optional: MEASURE_BORROW_USER=0x... (the address that borrows) and MEASURE_BORROW_ASSET: also emulates the real
// Pool.borrow and prints its account count (the pool reads RomePriceOracle, so this is the count with it).
//   MEASURE_PAYER=<base58> [MEASURE_USER=0x...] [RPC_URL=...] npx hardhat run scripts/measure-rome-price-oracle.ts
import { ethers } from "ethers";
import { loadDeployments, readJson } from "./lib/oracle-common.js";

const env = (k: string, d = "") => process.env[k] || d;
type Acct = { pubkey: string; is_writable: boolean };

async function main() {
  const payer = env("MEASURE_PAYER");
  if (!payer) throw new Error("set MEASURE_PAYER=<base58 pubkey of any funded devnet wallet>");
  const user = env("MEASURE_USER", "0x0000000000000000000000000000000000000001");
  const provider = new ethers.JsonRpcProvider(env("RPC_URL", "https://hadrian.testnet.romeprotocol.xyz/"));
  const dep = loadDeployments();
  const lean = readJson("deployments/hadrian-oracle-lean-shims.json").shims as Record<string, { asset: string; book: string; sourceAccount: string }>;
  const aaveOracle: string = dep.AaveOracle.address;
  const pool: string = dep.Pool.address;
  const emu = async (to: string, data: string, from = user): Promise<Acct[]> => (await provider.send("rome_emulateCallAccounts", [{ from, to, data }, payer])) as Acct[];
  const iOr = new ethers.Interface(["function getAssetPrice(address) view returns (uint256)", "function getAssetsPrices(address[]) view returns (uint256[])", "function getSourceOfAsset(address) view returns (address)"]);
  const iBook = new ethers.Interface(["function entryOf(bytes32) view returns (int256,uint64,uint64,uint8)"]);
  const oracleNow = new ethers.Contract(aaveOracle, iOr, provider);

  console.log(`payer ${payer}  AaveOracle ${aaveOracle}  PriceBook ${Object.values(lean)[0].book}`);
  const syms = ["wUSDC", "wETH", "wSOL"].filter((s) => dep._reserves?.[s] && lean[s]);
  const per: { sym: string; a: Set<string>; c: Set<string> }[] = [];
  console.log("asset  (a) AaveOracle.getAssetPrice  (c) direct book read  RomePriceOracle est. (c+1)  saving   AaveOracle source");
  for (const s of syms) {
    const asset = lean[s].asset;
    const a = await emu(aaveOracle, iOr.encodeFunctionData("getAssetPrice", [asset]));
    const c = await emu(lean[s].book, iBook.encodeFunctionData("entryOf", [lean[s].sourceAccount]));
    per.push({ sym: s, a: new Set(a.map((x) => x.pubkey)), c: new Set(c.map((x) => x.pubkey)) });
    console.log(`${s.padEnd(5)}  ${String(a.length).padStart(27)}  ${String(c.length).padStart(19)}  ${String(c.length + 1).padStart(25)}  ${String(a.length - c.length - 1).padStart(6)}   ${await oracleNow.getSourceOfAsset(asset)}`);
  }
  console.log("k prices read together (one call):  AaveOracle.getAssetsPrices | RomePriceOracle est. | saving");
  const uc = new Set<string>();
  for (let k = 1; k <= syms.length; k++) {
    per[k - 1].c.forEach((p) => uc.add(p));
    const a = await emu(aaveOracle, iOr.encodeFunctionData("getAssetsPrices", [syms.slice(0, k).map((s) => lean[s].asset)]));
    console.log(`  k=${k} (${syms.slice(0, k).join("+")}): ${a.length} | ${uc.size + 1} | ${a.length - uc.size - 1}`);
  }

  const bu = env("MEASURE_BORROW_USER");
  if (bu) {
    const asset = dep._reserves[env("MEASURE_BORROW_ASSET", "wUSDC")].asset;
    const dec = Number(await new ethers.Contract(asset, ["function decimals() view returns (uint8)"], provider).decimals());
    const data = new ethers.Interface(["function borrow(address,uint256,uint256,uint16,address)"]).encodeFunctionData("borrow", [asset, ethers.parseUnits("0.1", dec), 2, 0, bu]);
    try { console.log(`Pool.borrow from ${bu}: accounts = ${(await emu(pool, data, bu)).length}`); } catch (e: any) { console.log(`Pool.borrow emulation: ${e.shortMessage ?? e.message}`); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
