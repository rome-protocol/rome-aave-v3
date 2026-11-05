// Point AaveOracle at the resilient BOOK shims in deployments/hadrian-oracle-shims.json with ONE
// setAssetSources call, for the reserves that are listed in the pool today (wBTC joins once listed).
// Prints getAssetPrice before and after. Reversible: scripts/revert-oracle-to-constants.ts.
//   npx hardhat run scripts/switch-oracle-to-book.ts --network hadrian
import hre from "hardhat";
import { loadDeployments, loadShims, listedSymbols, printPrices } from "./lib/oracle-common.js";

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const dep = loadDeployments(); const shims = loadShims();
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
