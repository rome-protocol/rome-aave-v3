// Deploy one BookFeedToV2ShimResilient per reserve (wUSDC, wETH, wSOL, wBTC) over the CURRENT
// PriceBook */USD-BOOK adapter, taken from the public registry (rome-protocol/rome-registry,
// chains/200010-hadrian/oracle.json via `gh api`).
// Fallback = a fixed 8-dec aggregator at the live book price read at deploy time (when the book
// stalls, the shim falls back to that fixed price). Aborts unless each shim answers the
// live book value. Writes deployments/hadrian-oracle-shims.json (committed). Deploys only; it does
// NOT touch AaveOracle (see scripts/switch-oracle-to-book.ts).
//   npx hardhat run scripts/deploy-book-shims.ts --network hadrian
import hre from "hardhat";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { BOOK_ABI, loadDeployments, usd, type ShimEntry } from "./lib/oracle-common.js";

const BASE: Record<string, string> = { wUSDC: "USDC", wETH: "ETH", wSOL: "SOL", wBTC: "BTC" };

const registry = (file: string) =>
  JSON.parse(
    Buffer.from(
      execFileSync("gh", ["api", `repos/rome-protocol/rome-registry/contents/chains/200010-hadrian/${file}`, "--jq", ".content"], { encoding: "utf8" }),
      "base64",
    ).toString("utf8"),
  );

async function main() {
  const { ethers } = await hre.network.connect();
  const [signer] = await ethers.getSigners();
  const dep = loadDeployments();
  const oracleJson = registry("oracle.json");
  const wbtc = registry("tokens.json").find((t: any) => t.symbol === "wBTC");
  if (!wbtc || wbtc.decimals !== 9) throw new Error("registry tokens.json has no 9-decimal wBTC");
  console.log(`deployer ${signer.address}`);

  // Preflight: every adapter must answer a positive 8-decimal price before anything is deployed.
  const plan: Record<string, { asset: string; primary: string; answer: bigint }> = {};
  for (const [sym, base] of Object.entries(BASE)) {
    const primary: string | undefined = oracleJson.feeds?.[`${base}/USD-BOOK`]?.address;
    if (!primary) throw new Error(`registry has no ${base}/USD-BOOK feed`);
    const asset: string = dep._reserves?.[sym]?.asset ?? (sym === "wBTC" ? wbtc.address : "");
    if (!asset) throw new Error(`no asset address for ${sym}`);
    const book = new ethers.Contract(primary, BOOK_ABI, signer);
    if ((await book.decimals()) !== 8n) throw new Error(`${sym}: ${primary} is not 8 decimals`);
    const [, answer] = await book.latestRoundData(); // reverts if the book is stale: abort
    if (!(answer > 0n)) throw new Error(`${sym}: book answered ${answer}`);
    plan[sym] = { asset, primary, answer };
    console.log(`  ${sym}: ${base}/USD-BOOK ${primary} serves ${usd(answer)}`);
  }

  const Fixed = await ethers.getContractFactory("MockAggregator");
  const Shim = await ethers.getContractFactory("BookFeedToV2ShimResilient");
  const shims: Record<string, ShimEntry> = {};
  const out = "deployments/hadrian-oracle-shims.json";
  // Written after every shim so a later abort never loses shims already on chain.
  const save = (failed?: string) => fs.writeFileSync(out, JSON.stringify({ deployedAt: new Date().toISOString(), deployer: signer.address, source: "rome-protocol/rome-registry chains/200010-hadrian/oracle.json", ...(failed ? { incomplete: `${failed} failed its latestAnswer check` } : {}), shims }, null, 2) + "\n");
  for (const [sym, p] of Object.entries(plan)) {
    const fixed = await Fixed.deploy(p.answer); await fixed.waitForDeployment();
    const fixedAddr = await fixed.getAddress();
    const shim = await Shim.deploy(p.primary, fixedAddr); await shim.waitForDeployment();
    const shimAddr = await shim.getAddress();
    // The fallback equals the live price today, so also prove the primary path: the shim points at the
    // registry adapter, the adapter answers on its own, and the shim returns that same live value.
    const book = new ethers.Contract(p.primary, BOOK_ABI, signer);
    const [, live] = await book.latestRoundData();
    const got: bigint = await shim.latestAnswer();
    if ((await shim.primary()).toLowerCase() !== p.primary.toLowerCase()) throw new Error(`${sym}: shim primary mismatch`);
    shims[sym] = { asset: p.asset, primary: p.primary, fallbackAggregator: fixedAddr, shim: shimAddr, priceAtDeploy: p.answer.toString() };
    if (got !== live) { save(sym); throw new Error(`${sym}: shim answered ${got}, live book ${live}; aborting (record written with the shims deployed so far, shim ${shimAddr} included)`); }
    console.log(`  ${sym}: shim ${shimAddr} fallback ${fixedAddr} latestAnswer ${usd(got)} == live book`);
    save();
  }
  console.log(`wrote ${out} (commit it)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
