// Shared helpers for the oracle scripts. Reads the committed deployments records.
import * as fs from "node:fs";

export const BOOK_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

export type ShimEntry = { asset: string; primary: string; fallbackAggregator: string; shim: string; priceAtDeploy: string };

export const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
export const loadDeployments = (net = "hadrian") => readJson(`deployments/${net}.json`);
export const loadShims = (net = "hadrian"): Record<string, ShimEntry> => {
  const rec = readJson(`deployments/${net}-oracle-shims.json`);
  if (rec.incomplete) throw new Error(`shims record is incomplete (${rec.incomplete}); fix and re-deploy before switching`);
  return rec.shims;
};
export const usd = (v: bigint) => `$${(Number(v) / 1e8).toFixed(4)}`;

/** Symbols of `candidates` that are listed reserves of the pool today. */
export async function listedSymbols(pool: any, candidates: Record<string, string>): Promise<string[]> {
  const listed = new Set<string>((await pool.getReservesList()).map((a: string) => a.toLowerCase()));
  return Object.keys(candidates).filter((s) => listed.has(candidates[s].toLowerCase()));
}

export async function printPrices(oracle: any, label: string, syms: string[], assets: Record<string, string>) {
  for (const s of syms) console.log(`  ${label} ${s}: ${usd(await oracle.getAssetPrice(assets[s]))} source=${await oracle.getSourceOfAsset(assets[s])}`);
}
