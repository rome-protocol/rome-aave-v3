import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Configures two demo e-mode categories on a target Aave V3 deployment:
//
//   id=1  "Stablecoin"  — USDC only. LTV 93% / LT 95% / bonus 1%.
//   id=2  "Crypto"      — ETH + SOL.  LTV 88% / LT 92% / bonus 3%.
//
// PoolConfigurator.setEModeCategory accepts BPS (basis points) for LTV +
// liqThreshold; liqBonus is encoded as percentageFactor + bonusBps, where
// percentageFactor = 10_000. So a 1% bonus is 10_100. The category id
// space is 1..255; id 0 means "no e-mode" and is implicit.
//
// Per-asset opt-in is two calls each:
//   setAssetCollateralInEMode(asset, categoryId, collateral=true)
//   setAssetBorrowableInEMode(asset, categoryId, borrowable=true)
// These must be called by the same role that owns setEModeCategory
// (Risk or Pool admin). The deployer holds Pool admin from the initial
// deploy.

interface EmodeCategoryDef {
  id: number;
  label: string;
  ltvBps: number;
  liquidationThresholdBps: number;
  /** Bonus in BPS over 10_000 — 10_100 = +1.0%. */
  liquidationBonusBps: number;
  assetSymbols: string[];
}

const CATEGORIES: EmodeCategoryDef[] = [
  {
    id: 1,
    label: "Stablecoin",
    ltvBps: 9300,
    liquidationThresholdBps: 9500,
    liquidationBonusBps: 10100,
    assetSymbols: ["wUSDC"],
  },
  {
    id: 2,
    label: "Crypto",
    ltvBps: 8800,
    liquidationThresholdBps: 9200,
    liquidationBonusBps: 10300,
    assetSymbols: ["wETH", "wSOL"],
  },
];

export default task("setup-emodes", "Configure E-mode categories + bind assets")
  .setInlineAction(async (_args, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const poolConfiguratorAddr = deployments.PoolConfigurator?.address;
    if (!poolConfiguratorAddr) {
      throw new Error("PoolConfigurator address missing from deployments file");
    }
    const reserves = (deployments._reserves ?? {}) as Record<string, { asset: string }>;

    console.log(`Network: ${networkSlug}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`PoolConfigurator: ${poolConfiguratorAddr}`);
    console.log();

    const poolConfigurator = await ethers.getContractAt(
      "PoolConfigurator",
      poolConfiguratorAddr,
    );

    for (const cat of CATEGORIES) {
      console.log(`── Category ${cat.id}: ${cat.label} ──`);
      console.log(`  LTV ${cat.ltvBps / 100}% / LT ${cat.liquidationThresholdBps / 100}% / bonus +${(cat.liquidationBonusBps - 10000) / 100}%`);
      const tx = await poolConfigurator.setEModeCategory(
        cat.id,
        cat.ltvBps,
        cat.liquidationThresholdBps,
        cat.liquidationBonusBps,
        cat.label,
      );
      const rc = await tx.wait();
      console.log(`  setEModeCategory tx=${rc?.hash} status=${rc?.status}`);

      for (const sym of cat.assetSymbols) {
        const reserve = reserves[sym];
        if (!reserve) {
          console.log(`  ! skipping ${sym}: not in deployments`);
          continue;
        }
        const colTx = await poolConfigurator.setAssetCollateralInEMode(reserve.asset, cat.id, true);
        await colTx.wait();
        const borTx = await poolConfigurator.setAssetBorrowableInEMode(reserve.asset, cat.id, true);
        await borTx.wait();
        console.log(`  ${sym} (${reserve.asset}) — collateral=true, borrowable=true`);
      }
      console.log();
    }

    console.log("E-mode setup complete.");
  })
  .build();
