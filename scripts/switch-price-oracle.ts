// Point the Aave pool at RomePriceOracle with ONE PoolAddressesProvider.setPriceOracle call, and back.
//   PRICE_ORACLE=rome (default)   set the provider's price oracle to deployments/hadrian-rome-price-oracle.json `oracle`
//   PRICE_ORACLE=previous         set it back to the AaveOracle address stored in that record as `previousOracle`
// Before the first switch the script reads the provider's CURRENT price oracle (the AaveOracle) and stores it in
// the record as `previousOracle` (it is never overwritten while the provider is still on the old one, so a re-run
// keeps it). Only the provider's owner may call setPriceOracle: the script aborts unless the signer is the owner.
// Pre-checks (abort): the new oracle prices EVERY reserve the pool lists (> 0), within 5% of the current oracle
// (set ALLOW_DEVIATION=1 to skip the 5% bound); after the call: getPriceOracle() is the new address, prices are
// printed again, and UiPoolDataProviderV3.getReservesData still answers (if not, switch back at once).
// Run as the provider owner; pool-wide effect: run it on its own and check prices after.
//   npx hardhat run scripts/switch-price-oracle.ts --network hadrian
//   PRICE_ORACLE=previous npx hardhat run scripts/switch-price-oracle.ts --network hadrian
import hre from "hardhat";
import * as fs from "node:fs";
import { loadDeployments, readJson, usd } from "./lib/oracle-common.js";

const REC = "deployments/hadrian-rome-price-oracle.json";
const ORACLE_ABI = ["function getAssetPrice(address) view returns (uint256)", "function getSourceOfAsset(address) view returns (address)"];

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const dep = loadDeployments();
  const rec = readJson(REC);
  if (rec.incomplete) throw new Error(`${REC} is incomplete (${rec.incomplete}); fix and re-deploy before switching`);
  const want = (process.env.PRICE_ORACLE ?? "rome").toLowerCase();
  if (want !== "rome" && want !== "previous") throw new Error(`PRICE_ORACLE must be "rome" or "previous", got "${want}"`);

  const provider = await ethers.getContractAt("PoolAddressesProvider", dep.PoolAddressesProvider.address);
  const owner: string = await provider.owner();
  const current: string = await provider.getPriceOracle();
  console.log(`PoolAddressesProvider ${dep.PoolAddressesProvider.address}  owner ${owner}  signer ${signer.address}`);
  console.log(`current price oracle ${current}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`signer ${signer.address} is not the provider owner ${owner}: only the owner may call setPriceOracle`);

  // Remember what to switch back to, once, while the provider is still on the old oracle.
  if (want === "rome" && current.toLowerCase() !== String(rec.oracle).toLowerCase()) {
    if (rec.previousOracle && rec.previousOracle.toLowerCase() !== current.toLowerCase()) console.log(`note: replacing stored previousOracle ${rec.previousOracle} with the current ${current}`);
    rec.previousOracle = current;
    fs.writeFileSync(REC, JSON.stringify(rec, null, 2) + "\n");
    console.log(`stored previousOracle ${current} in ${REC} (commit it)`);
  }
  const target: string = want === "rome" ? rec.oracle : rec.previousOracle;
  if (!target || !ethers.isAddress(target)) throw new Error(`no ${want === "rome" ? "oracle" : "previousOracle"} address in ${REC}`);
  if (current.toLowerCase() === target.toLowerCase()) { console.log("provider already points at the target; nothing to do"); return; }
  if (want === "previous" && !rec.previousOracle) throw new Error("no previousOracle stored");

  const pool = await ethers.getContractAt("Pool", dep.Pool.address);
  const reserves: string[] = await pool.getReservesList();
  const sym = (a: string) => Object.entries(dep._reserves ?? {}).find(([, r]: any) => r.asset.toLowerCase() === a.toLowerCase())?.[0] ?? a;
  const cur = new ethers.Contract(current, ORACLE_ABI, signer);
  const next = new ethers.Contract(target, ORACLE_ABI, signer);

  console.log("before (current oracle) vs new oracle, per listed reserve:");
  for (const a of reserves) {
    const before: bigint = await cur.getAssetPrice(a);
    let after: bigint;
    try { after = await next.getAssetPrice(a); } catch (e: any) { throw new Error(`new oracle ${target} cannot price listed reserve ${sym(a)} ${a}: ${e.shortMessage ?? e.message}`); }
    if (!(after > 0n)) throw new Error(`new oracle prices ${sym(a)} at ${after}`);
    const dev = before > 0n ? Number((after > before ? after - before : before - after) * 10000n / before) / 100 : 0;
    console.log(`  ${sym(a)}: ${usd(before)} -> ${usd(after)} (${dev}% apart)`);
    if (dev > 5 && !process.env.ALLOW_DEVIATION) throw new Error(`${sym(a)}: ${dev}% apart (> 5%); set ALLOW_DEVIATION=1 to switch anyway`);
  }

  const tx = await provider.setPriceOracle(target);
  console.log("setPriceOracle tx:", tx.hash); await tx.wait();
  const now: string = await provider.getPriceOracle();
  if (now.toLowerCase() !== target.toLowerCase()) throw new Error(`getPriceOracle() is ${now}, expected ${target}`);
  console.log(`price oracle is now ${now}`);
  const live = new ethers.Contract(now, ORACLE_ABI, signer);
  for (const a of reserves) console.log(`  after  ${sym(a)}: ${usd(await live.getAssetPrice(a))}`);
  if (dep.UiPoolDataProviderV3?.address) {
    try {
      const ui = await ethers.getContractAt("UiPoolDataProviderV3", dep.UiPoolDataProviderV3.address);
      const [data, base] = await ui.getReservesData(dep.PoolAddressesProvider.address);
      console.log(`UiPoolDataProviderV3.getReservesData ok: ${data.length} reserves, marketReferenceCurrencyUnit ${base.marketReferenceCurrencyUnit}`);
    } catch (e: any) { console.error(`WARNING: UiPoolDataProviderV3.getReservesData failed after the switch (${e.shortMessage ?? e.message}); switch back with PRICE_ORACLE=previous`); process.exitCode = 1; }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
