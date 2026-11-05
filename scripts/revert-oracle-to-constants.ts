// Point AaveOracle back at the constant aggregators: deployments/hadrian.json#_reserves[sym].mockAggregator,
// or, for a reserve listed later with a shim (wBTC), the fixed fallback aggregator recorded in
// deployments/hadrian-oracle-shims.json. Only reserves listed in the pool are touched.
//   npx hardhat run scripts/revert-oracle-to-constants.ts --network hadrian
import hre from "hardhat";
import { loadDeployments, loadShims, listedSymbols, printPrices } from "./lib/oracle-common.js";

async function main() {
  const { ethers } = await hre.network.connect();
  const dep = loadDeployments();
  const oracle = await ethers.getContractAt("AaveOracle", dep.AaveOracle.address);
  const pool = await ethers.getContractAt("Pool", dep.Pool.address);
  const assets: Record<string, string> = {}; const constants: Record<string, string> = {};
  for (const [s, r] of Object.entries<any>(dep._reserves ?? {})) { assets[s] = r.asset; constants[s] = r.mockAggregator; }
  try { for (const [s, e] of Object.entries(loadShims())) if (!constants[s]) { assets[s] = e.asset; constants[s] = e.fallbackAggregator; } } catch { /* no shims record */ }
  const syms = await listedSymbols(pool, assets);
  await printPrices(oracle, "before", syms, assets);
  const tx = await oracle.setAssetSources(syms.map((s) => assets[s]), syms.map((s) => constants[s]));
  console.log("setAssetSources tx:", tx.hash); await tx.wait();
  await printPrices(oracle, "after ", syms, assets);
}
main().catch((e) => { console.error(e); process.exit(1); });
