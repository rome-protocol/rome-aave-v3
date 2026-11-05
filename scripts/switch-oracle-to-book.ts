// Point AaveOracle at the BOOK price shims with ONE setAssetSources call, for the reserves that are listed
// in the pool today (wBTC joins once listed). Prints getAssetPrice before and after.
//   ORACLE_SHIMS=book (default)  deployments/hadrian-oracle-shims.json       BookFeedToV2ShimResilient (via the adapter)
//   ORACLE_SHIMS=lean            deployments/hadrian-oracle-lean-shims.json  PriceBookEntryShim (reads the PriceBook directly)
// Switch to lean and back to the adapter shims by running it with the other value; to go back to the constant
// aggregators use scripts/revert-oracle-to-constants.ts.
//   ORACLE_SHIMS=lean npx hardhat run scripts/switch-oracle-to-book.ts --network hadrian
import hre from "hardhat";
import { loadDeployments, loadSwitchTargets, listedSymbols, printPrices } from "./lib/oracle-common.js";

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const dep = loadDeployments(); const shims = loadSwitchTargets();
  console.log(`shim record: ${process.env.ORACLE_SHIMS ?? "book"}`);
  const oracle = await ethers.getContractAt("AaveOracle", dep.AaveOracle.address);
  const pool = await ethers.getContractAt("Pool", dep.Pool.address);
  const assets = Object.fromEntries(Object.entries(shims).map(([s, e]) => [s, e.asset]));
  const syms = await listedSymbols(pool, assets);
  if (!syms.length) throw new Error("no shimmed reserve is listed in the pool");
  console.log(`AaveOracle ${dep.AaveOracle.address} admin-signer ${signer.address} reserves ${syms.join(",")}`);
  await printPrices(oracle, "before", syms, assets);
  const tx = await oracle.setAssetSources(syms.map((s) => assets[s]), syms.map((s) => shims[s].shim));
  console.log("setAssetSources tx:", tx.hash); await tx.wait();
  await printPrices(oracle, "after ", syms, assets);
}
main().catch((e) => { console.error(e); process.exit(1); });
