import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Supplies a configurable fraction of the deployer-held wrapper balance into the
// Aave pool for each reserve listed in deployments/<network>.json. Without args,
// supplies 80% of every non-zero balance — enough to unblock small demo borrows
// after a fresh deploy (post-init, aTokens are dust-only). Pass --symbol to
// restrict to one reserve and --amount to override the auto-fraction with an
// explicit human-decimal amount.
//
// Approval flow matches the rest of the suite: probe allowance, send a fresh
// approve(supplyAmount) only when insufficient. Pool.supply(asset, amount,
// onBehalfOf=signer, referralCode=0) — `onBehalfOf` parks the aTokens on the
// deployer, so re-running redeposits compound rather than mint new positions
// for the demo.

interface ReserveDef {
  asset: string;
  aToken: string;
  decimals: number;
}

export default task("seed-pool", "Supply deployer-held wrapper liquidity into the Aave pool")
  .addOption({ name: "symbol", description: "Restrict to one reserve symbol (e.g., wUSDC)", defaultValue: "" })
  .addOption({ name: "amount", description: "Human-decimal amount to supply (requires --symbol)", defaultValue: "" })
  .addOption({ name: "fraction", description: "Fraction of balance to supply when no --amount (0 < f <= 1). Default 0.8.", defaultValue: "0.8" })
  .setInlineAction(async ({ symbol, amount, fraction }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const poolAddr = deployments.Pool?.address;
    if (!poolAddr) {
      throw new Error("Pool address missing from deployments file");
    }
    const reserves = (deployments._reserves ?? {}) as Record<string, ReserveDef>;
    if (Object.keys(reserves).length === 0) {
      throw new Error("_reserves missing from deployments file — run init-reserve first");
    }

    if (amount && !symbol) {
      throw new Error("--amount requires --symbol");
    }
    const fractionN = parseFloat(fraction);
    if (!(fractionN > 0 && fractionN <= 1)) {
      throw new Error(`--fraction must satisfy 0 < f <= 1 (got ${fraction})`);
    }

    const targets = symbol ? [symbol] : Object.keys(reserves);

    const pool = await ethers.getContractAt("IPool", poolAddr);

    console.log(`Network: ${networkSlug}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`Pool:    ${poolAddr}`);
    console.log(`Targets: ${targets.join(", ")}`);
    console.log();

    for (const sym of targets) {
      const reserve = reserves[sym];
      if (!reserve) {
        console.log(`! skipping ${sym}: not in _reserves`);
        continue;
      }

      const erc20 = await ethers.getContractAt("IERC20", reserve.asset);
      const balance: bigint = await erc20.balanceOf(signer.address);

      let supplyAmount: bigint;
      if (amount) {
        supplyAmount = ethers.parseUnits(amount, reserve.decimals);
        if (supplyAmount > balance) {
          throw new Error(
            `${sym}: requested ${amount} exceeds balance ${ethers.formatUnits(balance, reserve.decimals)}`,
          );
        }
      } else {
        // BigInt-safe fractional: convert fraction → BPS, then (balance * bps) / 10_000.
        const percentBp = BigInt(Math.floor(fractionN * 10_000));
        supplyAmount = (balance * percentBp) / 10_000n;
      }

      console.log(`── ${sym} ──`);
      console.log(`  balance:       ${ethers.formatUnits(balance, reserve.decimals)} (raw ${balance})`);
      console.log(`  supplyAmount:  ${ethers.formatUnits(supplyAmount, reserve.decimals)} (raw ${supplyAmount})`);

      if (supplyAmount === 0n) {
        console.log(`  skipping ${sym}: supplyAmount=0`);
        console.log();
        continue;
      }

      const aToken = await ethers.getContractAt("IERC20", reserve.aToken);
      const beforeTS: bigint = await aToken.totalSupply();
      console.log(`  aToken.totalSupply before: ${ethers.formatUnits(beforeTS, reserve.decimals)}`);

      const allowance: bigint = await erc20.allowance(signer.address, poolAddr);
      if (allowance < supplyAmount) {
        console.log(`  approve(${supplyAmount}) — current allowance ${allowance}`);
        const approveTx = await erc20.approve(poolAddr, supplyAmount);
        const arc = await approveTx.wait();
        console.log(`  approve tx=${arc?.hash} status=${arc?.status}`);
      } else {
        console.log(`  allowance sufficient: ${allowance}`);
      }

      const supplyTx = await pool.supply(reserve.asset, supplyAmount, signer.address, 0);
      const src = await supplyTx.wait();
      console.log(`  supply  tx=${src?.hash} status=${src?.status}`);

      const afterTS: bigint = await aToken.totalSupply();
      console.log(`  aToken.totalSupply after:  ${ethers.formatUnits(afterTS, reserve.decimals)}`);
      console.log();
    }

    console.log("Seed complete.");
  })
  .build();
