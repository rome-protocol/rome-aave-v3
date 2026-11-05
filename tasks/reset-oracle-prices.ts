import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Points each mock-priced reserve's AaveOracle source at a fresh MockAggregator at the USD price
// recorded in deployments/<network>.json#_reserves (for example after a test moved a price).
// Reserves on a PriceBook shim are left alone.
//
// Per asset: deploy a fresh MockAggregator at the recorded USD price and call
// AaveOracle.setAssetSources to overwrite the current source.

export default task("reset-oracle-prices", "Restore oracle sources to canonical mock prices")
  .setInlineAction(async (_args, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const oracleAddr = deployments.AaveOracle.address;
    const reserves = deployments._reserves ?? {};

    console.log(`Network: ${networkSlug}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`Oracle:  ${oracleAddr}`);

    const oracle = await ethers.getContractAt("AaveOracle", oracleAddr);
    const MockAggregator = await ethers.getContractFactory("MockAggregator");

    const assets: string[] = [];
    const sources: string[] = [];

    // Reserves already on a BOOK shim (deployments/<net>-oracle-shims.json) or a lean PriceBook shim
    // (deployments/<net>-oracle-lean-shims.json) stay on it.
    const shimOf: Record<string, string[]> = {};
    for (const file of [`${networkSlug}-oracle-shims.json`, `${networkSlug}-oracle-lean-shims.json`]) {
      const shimsPath = path.join("deployments", file);
      if (!fs.existsSync(shimsPath)) continue;
      for (const s of Object.values(JSON.parse(fs.readFileSync(shimsPath, "utf8")).shims ?? {}) as any[]) {
        (shimOf[s.asset.toLowerCase()] ??= []).push(s.shim.toLowerCase());
      }
    }

    for (const [sym, r] of Object.entries(reserves)) {
      const reserve = r as any;
      const priceUsd = reserve.priceUsd;
      if (priceUsd == null) {
        console.log(`  skipping ${sym}: no priceUsd in artifact`);
        continue;
      }
      const priceScaled = BigInt(Math.round(parseFloat(String(priceUsd)) * 1e8));
      const currentSource: string = await oracle.getSourceOfAsset(reserve.asset);
      if ((shimOf[reserve.asset.toLowerCase()] ?? []).includes(currentSource.toLowerCase())) {
        console.log(`  ${sym}: on a price shim ${currentSource} - skipped (run switch-oracle-to-book.ts / revert-oracle-to-constants.ts to change it)`);
        continue;
      }
      const currentValue: bigint = await (await ethers.getContractAt("MockAggregator", currentSource)).latestAnswer();

      if (currentValue === priceScaled) {
        console.log(`  ${sym}: source=${currentSource} answer=${currentValue} OK — no change`);
        continue;
      }

      const aggregator = await MockAggregator.deploy(priceScaled);
      await aggregator.waitForDeployment();
      const newAddr = await aggregator.getAddress();
      console.log(`  ${sym}: was ${currentValue} via ${currentSource} -> ${priceScaled} via ${newAddr}`);

      assets.push(reserve.asset);
      sources.push(newAddr);

      // Update the artifact so subsequent reads see the fresh mock.
      reserve.mockAggregator = newAddr;
    }

    if (assets.length === 0) {
      console.log("All oracle sources already at canonical values. Nothing to do.");
      return;
    }

    const tx = await oracle.setAssetSources(assets, sources);
    await tx.wait();
    console.log(`oracle.setAssetSources(${assets.length} assets): PASS`);

    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log(`Updated ${deploymentsPath}`);
  })
  .build();
