// Unit test for RomePriceOracle: live / stale / missing / paused / future / non-positive entries and an unreachable
// book; unknown asset reverts; BASE_CURRENCY handling; getAssetsPrices / getSourceOfAsset / getFallbackOracle; and
// equality with PriceBookEntryShim for the same entry on every asset and every case.
//   npx hardhat run test/rome-price-oracle.test.ts
import hre from "hardhat";
import assert from "node:assert/strict";

const KEYS = [1, 2, 3, 4].map((n) => "0x" + n.toString(16).padStart(2, "0").repeat(32));
const STALE = [3600n, 3600n, 1800n, 7200n]; // distinct bounds prove per-asset staleness is wired to the right slot
const FALLBACK = [99_971_505n, 225_056_700_856n, 8_934_242_348n, 7_601_703_619_686n];
const LIVE = [100_010_000n, 230_000_000_000n, 9_572_000_000n, 7_700_000_000_000n];

async function main() {
  const { ethers } = await hre.network.connect();
  const Book = await ethers.getContractFactory("MockPriceBook");
  const Shim = await ethers.getContractFactory("PriceBookEntryShim");
  const Oracle = await ethers.getContractFactory("RomePriceOracle");

  const book = await Book.deploy(); await book.waitForDeployment();
  const bookAddr = await book.getAddress();
  const assets = ["0x" + "a1".repeat(20), "0x" + "a2".repeat(20), "0x" + "a3".repeat(20), "0x" + "a4".repeat(20)].map((a) => ethers.getAddress(a));
  const cfg = assets.map((asset, i) => ({ asset, sourceAccount: KEYS[i], maxStaleness: STALE[i], fallbackPrice: FALLBACK[i] }));
  const oracle = await Oracle.deploy(bookAddr, cfg); await oracle.waitForDeployment();
  const shims = [];
  for (let i = 0; i < 4; i++) { const s = await Shim.deploy(bookAddr, KEYS[i], STALE[i], FALLBACK[i]); await s.waitForDeployment(); shims.push(s); }

  const now = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const set = async (i: number, price: bigint, age: bigint, status: number) => { // age may be negative (future)
    await (await book.setEntry(KEYS[i], price, (await now()) - age, status)).wait();
  };
  const check = async (i: number, label: string, expected: bigint) => {
    assert.equal(await oracle.getAssetPrice(assets[i]), expected, `oracle[${i}] ${label}`);
    assert.equal(await oracle.getAssetPrice(assets[i]), BigInt(await shims[i].latestAnswer()), `oracle == PriceBookEntryShim[${i}] ${label}`);
  };

  for (let i = 0; i < 4; i++) {
    const S = STALE[i], L = LIVE[i], F = FALLBACK[i];
    const cases: [string, bigint, bigint, number, bigint][] = [
      ["live", L, 60n, 1, L],
      ["just inside staleness", L, S - 120n, 1, L],
      ["just past staleness", L, S + 120n, 1, F],
      ["very stale", L, 86_400n, 1, F],
      ["never written (status 0)", 0n, 0n, 0, F],
      ["paused (status 2)", L, 60n, 2, F],
      ["future publishTime", L, -600n, 1, F],
      ["zero answer", 0n, 60n, 1, F],
      ["negative answer", -5n, 60n, 1, F],
      ["live again after a refresh", L + 1n, 30n, 1, L + 1n],
    ];
    for (const [label, price, age, status, expected] of cases) { await set(i, price, age, status); await check(i, label, expected); }
  }

  // An entry for one key never leaks into another asset (missing entry for the others -> their fallback).
  await set(0, LIVE[0], 60n, 1);
  for (let i = 1; i < 4; i++) { await (await book.setEntry(KEYS[i], 0, 0, 0)).wait(); }
  assert.equal(await oracle.getAssetPrice(assets[0]), LIVE[0]);
  for (let i = 1; i < 4; i++) assert.equal(await oracle.getAssetPrice(assets[i]), FALLBACK[i], `asset ${i} falls back while only asset 0 is written`);

  // Unreachable book -> every asset gives its fallback, never a revert.
  for (let i = 0; i < 4; i++) await set(i, LIVE[i], 60n, 1);
  await (await book.setBroken(true)).wait();
  for (let i = 0; i < 4; i++) await check(i, "book reverts", FALLBACK[i]);
  await (await book.setBroken(false)).wait();
  for (let i = 0; i < 4; i++) await check(i, "book back", LIVE[i]);

  // Unknown asset reverts (AaveOracle on Hadrian reverts too: no fallback oracle).
  const stranger = "0x" + "ee".repeat(20);
  await assert.rejects(oracle.getAssetPrice(stranger), "unknown asset reverts");
  await assert.rejects(oracle.getAssetsPrices([assets[0], stranger]), "unknown asset in a batch reverts");
  await assert.rejects(oracle.assetConfig(stranger), "assetConfig of unknown asset reverts");

  // BASE_CURRENCY = USD (zero address) prices at BASE_CURRENCY_UNIT, as AaveOracle does.
  assert.equal(await oracle.BASE_CURRENCY(), ethers.ZeroAddress);
  assert.equal(await oracle.BASE_CURRENCY_UNIT(), 100_000_000n);
  assert.equal(await oracle.getAssetPrice(ethers.ZeroAddress), 100_000_000n);

  // Batch + getters.
  assert.deepEqual([...(await oracle.getAssetsPrices(assets))].map(BigInt), LIVE);
  assert.deepEqual([...(await oracle.getAssetsPrices([]))], []);
  assert.equal(await oracle.getSourceOfAsset(assets[2]), await oracle.getAddress());
  assert.equal(await oracle.getSourceOfAsset(stranger), ethers.ZeroAddress);
  assert.equal(await oracle.getFallbackOracle(), ethers.ZeroAddress);
  assert.equal((await oracle.book()).toLowerCase(), bookAddr.toLowerCase());
  for (let i = 0; i < 4; i++) {
    const [k, s, f] = await oracle.assetConfig(assets[i]);
    assert.equal(k.toLowerCase(), KEYS[i]); assert.equal(BigInt(s), STALE[i]); assert.equal(BigInt(f), FALLBACK[i]);
  }

  // Constructor guards.
  const bad = (i: number, patch: object) => cfg.map((c, j) => (j === i ? { ...c, ...patch } : c));
  await assert.rejects(Oracle.deploy(ethers.ZeroAddress, cfg), "zero book");
  await assert.rejects(Oracle.deploy((await ethers.getSigners())[0].address, cfg), "book must be a contract");
  await assert.rejects(Oracle.deploy(bookAddr, bad(3, { asset: ethers.ZeroAddress })), "zero asset");
  await assert.rejects(Oracle.deploy(bookAddr, bad(3, { asset: assets[0] })), "duplicate asset");
  await assert.rejects(Oracle.deploy(bookAddr, bad(1, { sourceAccount: ethers.ZeroHash })), "zero source");
  await assert.rejects(Oracle.deploy(bookAddr, bad(2, { maxStaleness: 0 })), "zero staleness");
  await assert.rejects(Oracle.deploy(bookAddr, bad(2, { maxStaleness: 86_401 })), "staleness > 24h");
  await assert.rejects(Oracle.deploy(bookAddr, bad(0, { fallbackPrice: 0n })), "zero fallback");
  await assert.rejects(Oracle.deploy(bookAddr, bad(0, { fallbackPrice: -1n })), "negative fallback");
  console.log("rome-price-oracle: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
