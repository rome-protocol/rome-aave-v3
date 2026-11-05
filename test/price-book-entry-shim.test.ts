// Unit test for PriceBookEntryShim: a valid PriceBook entry serves live; stale / missing / paused / future /
// non-positive entries and an unreachable book give the fixed fallback; decimals 8; and the shim answers
// like BookFeedToV2ShimResilient over the real BookFeedAdapter read path for the same entry.
//   npx hardhat run test/price-book-entry-shim.test.ts
import hre from "hardhat";
import assert from "node:assert/strict";

const SRC = "0x" + "42".repeat(32);
const MAX_STALE = 3600n;
const FALLBACK = 20_000_000_000n; // $200
const LIVE = 9_572_000_000n; // $95.72

async function main() {
  const { ethers } = await hre.network.connect();
  const Book = await ethers.getContractFactory("MockPriceBook");
  const Adapter = await ethers.getContractFactory("BookFeedAdapterRef");
  const Fixed = await ethers.getContractFactory("MockAggregator");
  const Old = await ethers.getContractFactory("BookFeedToV2ShimResilient");
  const Lean = await ethers.getContractFactory("PriceBookEntryShim");

  const book = await Book.deploy(); await book.waitForDeployment();
  const bookAddr = await book.getAddress();
  const adapter = await Adapter.deploy(bookAddr, SRC, MAX_STALE); await adapter.waitForDeployment();
  const fixed = await Fixed.deploy(FALLBACK); await fixed.waitForDeployment();
  const old = await Old.deploy(await adapter.getAddress(), await fixed.getAddress()); await old.waitForDeployment();
  const lean = await Lean.deploy(bookAddr, SRC, MAX_STALE, FALLBACK); await lean.waitForDeployment();

  const now = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const set = async (price: bigint, age: bigint, status: number) => { // age may be negative (future publishTime)
    const t = await now();
    await (await book.setEntry(SRC, price, t - age, status)).wait();
  };

  // [label, price, age seconds, status, expected]
  const cases: [string, bigint, bigint, number, bigint][] = [
    ["fresh live entry", LIVE, 60n, 1, LIVE],
    ["just inside staleness", LIVE, MAX_STALE - 120n, 1, LIVE],
    ["just past staleness", LIVE, MAX_STALE + 120n, 1, FALLBACK],
    ["very stale", LIVE, 86_400n, 1, FALLBACK],
    ["never written (status 0)", 0n, 0n, 0, FALLBACK],
    ["paused (status 2), fresh price retained", LIVE, 60n, 2, FALLBACK],
    ["future publishTime", LIVE, -600n, 1, FALLBACK],
    ["zero answer", 0n, 60n, 1, FALLBACK],
    ["negative answer", -5n, 60n, 1, FALLBACK],
    ["live again after a refresh", 9_600_000_000n, 30n, 1, 9_600_000_000n],
  ];
  for (const [label, price, age, status, expected] of cases) {
    await set(price, age, status);
    assert.equal(await lean.latestAnswer(), expected, `lean: ${label}`);
    // Same answer as the current two-hop shim (adapter + fixed aggregator at the same fixed price).
    assert.equal(await old.latestAnswer(), expected, `old shim agrees: ${label}`);
  }

  // Same entry, adapter vs lean: when the adapter serves a positive answer the lean shim serves the same number;
  // when the adapter reverts the lean shim serves the fixed fallback.
  await set(LIVE, 60n, 1);
  const [, adapterAnswer] = await adapter.latestRoundData();
  assert.equal(await lean.latestAnswer(), adapterAnswer, "lean == adapter for a valid entry");
  await set(LIVE, MAX_STALE + 120n, 1);
  await assert.rejects(adapter.latestRoundData(), "adapter reverts on a stale entry");
  assert.equal(await lean.latestAnswer(), FALLBACK, "lean falls back where the adapter reverts");

  // A confidence interval that is too wide is the same as the stale case: PriceBook._refreshOne
  // (rome-solidity PriceBook.sol:274) writes nothing when conf*10000 > price*maxConfBps, so the old entry
  // ages out and the shim falls back, exactly as tested above. The shim never sees the confidence value.

  // Unreachable book -> fallback, never a revert.
  await set(LIVE, 60n, 1);
  await (await book.setBroken(true)).wait();
  assert.equal(await lean.latestAnswer(), FALLBACK, "book reverts -> fallback");
  await (await book.setBroken(false)).wait();
  assert.equal(await lean.latestAnswer(), LIVE, "book back -> live");

  // A different source key is a different entry (missing -> fallback).
  const other = await Lean.deploy(bookAddr, "0x" + "07".repeat(32), MAX_STALE, FALLBACK); await other.waitForDeployment();
  assert.equal(await other.latestAnswer(), FALLBACK, "missing entry for another key -> fallback");

  assert.equal(await lean.decimals(), 8n);
  assert.equal(await lean.maxStaleness(), MAX_STALE);
  assert.equal(await lean.fallbackPrice(), FALLBACK);
  assert.equal((await lean.sourceAccount()).toLowerCase(), SRC);
  assert.equal((await lean.book()).toLowerCase(), bookAddr.toLowerCase());

  // Constructor guards.
  const z = ethers.ZeroAddress;
  await assert.rejects(Lean.deploy(z, SRC, MAX_STALE, FALLBACK), "zero book");
  await assert.rejects(Lean.deploy((await ethers.getSigners())[0].address, SRC, MAX_STALE, FALLBACK), "book must be a contract");
  await assert.rejects(Lean.deploy(bookAddr, ethers.ZeroHash, MAX_STALE, FALLBACK), "zero source");
  await assert.rejects(Lean.deploy(bookAddr, SRC, 0n, FALLBACK), "zero staleness");
  await assert.rejects(Lean.deploy(bookAddr, SRC, 86_401n, FALLBACK), "staleness > 24h");
  await assert.rejects(Lean.deploy(bookAddr, SRC, MAX_STALE, 0n), "zero fallback");
  await assert.rejects(Lean.deploy(bookAddr, SRC, MAX_STALE, -1n), "negative fallback");
  console.log("price-book-entry-shim: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
