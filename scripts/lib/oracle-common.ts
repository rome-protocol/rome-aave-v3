// Shared helpers for the oracle scripts. Reads the committed deployments records.
import * as fs from "node:fs";

export const BOOK_ABI = [
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function decimals() view returns (uint8)",
];

export type ShimEntry = { asset: string; primary: string; fallbackAggregator: string; shim: string; priceAtDeploy: string };
/** One entry of deployments/<net>-oracle-lean-shims.json (PriceBookEntryShim): no adapter, no fallback contract. */
export type LeanShimEntry = { asset: string; shim: string; book: string; sourceAccount: string; maxStaleness: number; fallbackPrice: string; priceAtDeploy: string };
/** What the switch script needs from either record kind. */
export type ShimRef = { asset: string; shim: string };

export const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
export const loadDeployments = (net = "hadrian") => readJson(`deployments/${net}.json`);
export const loadShims = (net = "hadrian"): Record<string, ShimEntry> => {
  const rec = readJson(`deployments/${net}-oracle-shims.json`);
  if (rec.incomplete) throw new Error(`shims record is incomplete (${rec.incomplete}); fix and re-deploy before switching`);
  return rec.shims;
};
/** Which record the switch script points AaveOracle at: ORACLE_SHIMS=lean (PriceBookEntryShim) or book (default, BookFeedToV2ShimResilient). */
export const oracleShimsKind = (): "book" | "lean" => {
  const k = (process.env.ORACLE_SHIMS ?? "book").toLowerCase();
  if (k !== "book" && k !== "lean") throw new Error(`ORACLE_SHIMS must be "book" or "lean", got "${k}"`);
  return k;
};
export const loadSwitchTargets = (net = "hadrian"): Record<string, ShimRef> => {
  if (oracleShimsKind() === "book") return loadShims(net);
  const rec = readJson(`deployments/${net}-oracle-lean-shims.json`);
  if (rec.incomplete) throw new Error(`lean shims record is incomplete (${rec.incomplete}); fix and re-deploy before switching`);
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
