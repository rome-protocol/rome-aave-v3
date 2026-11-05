// Unit test for BookFeedToV2ShimResilient: primary serves; primary reverts or answers <= 0 -> fixed fallback.
//   npx hardhat run test/book-shim-resilient.test.ts
import hre from "hardhat";
import assert from "node:assert/strict";

async function main() {
  const { ethers } = await hre.network.connect();
  const Book = await ethers.getContractFactory("MockBookAdapter");
  const Fixed = await ethers.getContractFactory("MockAggregator");
  const Shim = await ethers.getContractFactory("BookFeedToV2ShimResilient");

  const book = await Book.deploy(9_572_000_000n); // $95.72
  const fixed = await Fixed.deploy(20_000_000_000n); // $200
  const shim = await Shim.deploy(await book.getAddress(), await fixed.getAddress());
  await Promise.all([book, fixed, shim].map((c) => c.waitForDeployment()));

  assert.equal(await shim.latestAnswer(), 9_572_000_000n, "primary serves");
  await (await book.set(9_600_000_000n, false)).wait();
  assert.equal(await shim.latestAnswer(), 9_600_000_000n, "primary follows the book");
  await (await book.set(9_600_000_000n, true)).wait();
  assert.equal(await shim.latestAnswer(), 20_000_000_000n, "primary reverts -> fallback");
  await (await book.set(0n, false)).wait();
  assert.equal(await shim.latestAnswer(), 20_000_000_000n, "non-positive answer -> fallback");
  await (await book.set(9_600_000_000n, false)).wait();
  assert.equal(await shim.latestAnswer(), 9_600_000_000n, "book recovers -> primary again");
  assert.equal(await shim.decimals(), 8n);
  await assert.rejects(Shim.deploy(ethers.ZeroAddress, await fixed.getAddress()), "zero primary rejected");
  console.log("book-shim-resilient: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
