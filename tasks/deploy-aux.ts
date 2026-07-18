import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Deploys the "auxiliary view helpers" added in the slim→full PR:
//   - WalletBalanceProvider: batch ERC-20 + native balance reads. Lets UIs
//     fetch all balances for a user in one call rather than per-asset.
//   - LiquidationDataProvider: liquidation params view helper. Returns
//     max-debt-to-cover / collateral-to-receive / bonus without simulating
//     the on-chain liquidationCall. Bound to the deployed PoolAddressesProvider.
//
// Both are pure-view contracts with no admin keys, no upgradeable proxies,
// and no on-chain state mutations. Safe to redeploy anytime — the address
// just gets re-registered in deployments/<network>.json.
//
// `PriceOracleSentinel` is NOT deployed here. It's an admin-set utility
// that requires a real Sequencer/grace-period config; on Rome (single
// validator settlement, no L2 sequencer) the sentinel pattern doesn't map
// cleanly. The source is vendored for completeness but only deployed when
// a Rome-specific sentinel design is decided.

export default task("deploy-aux", "Deploy auxiliary view helpers: WalletBalanceProvider + LiquidationDataProvider")
  .setInlineAction(async (_args, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [deployer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}. Run \`hardhat deploy --network ${networkSlug}\` first.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const providerAddr = deployments.PoolAddressesProvider?.address;
    if (!providerAddr) throw new Error("PoolAddressesProvider missing");

    console.log(`Network:                ${networkSlug}`);
    console.log(`Deployer:               ${deployer.address}`);
    console.log(`PoolAddressesProvider:  ${providerAddr}`);
    console.log();

    const deployedAt = new Date().toISOString();

    // WalletBalanceProvider — constructor takes no args. Idempotent.
    let wbpAddr: string;
    if (deployments.WalletBalanceProvider?.address) {
      wbpAddr = deployments.WalletBalanceProvider.address;
      console.log(`WalletBalanceProvider:   ${wbpAddr} (already deployed, reusing)`);
    } else {
      const WBP = await ethers.getContractFactory("WalletBalanceProvider");
      const wbp = await WBP.deploy();
      await wbp.waitForDeployment();
      wbpAddr = await wbp.getAddress();
      console.log(`WalletBalanceProvider:   ${wbpAddr}`);
    }

    // LiquidationDataProvider(pool, addressesProvider).
    const poolAddr = deployments.Pool?.address;
    if (!poolAddr) throw new Error("Pool address missing");
    const LDP = await ethers.getContractFactory("LiquidationDataProvider");
    const ldp = await LDP.deploy(poolAddr, providerAddr);
    await ldp.waitForDeployment();
    const ldpAddr = await ldp.getAddress();
    console.log(`LiquidationDataProvider: ${ldpAddr}`);

    deployments.WalletBalanceProvider = { address: wbpAddr, deployedAt };
    deployments.LiquidationDataProvider = {
      address: ldpAddr,
      deployedAt,
      ctor: { pool: poolAddr, addressesProvider: providerAddr },
    };
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log(`\nWrote both addresses to ${deploymentsPath}`);

    // Smoke-call each: should succeed without revert.
    const wbpInstance = await ethers.getContractAt("WalletBalanceProvider", wbpAddr);
    const reserves = deployments._reserves ?? {};
    const allAssets = Object.values(reserves).map((r: any) => r.asset).filter(Boolean);
    if (allAssets.length > 0) {
      const balances = await wbpInstance.batchBalanceOf([deployer.address], allAssets);
      console.log(`  smoke WalletBalanceProvider.batchBalanceOf(deployer, ${allAssets.length} assets): ${balances.length} balances returned`);
    }
    const ldpInstance = await ethers.getContractAt("LiquidationDataProvider", ldpAddr);
    const userPosition = await ldpInstance.getUserPositionFullInfo(deployer.address);
    console.log(`  smoke LiquidationDataProvider.getUserPositionFullInfo(deployer): healthFactor=${userPosition.healthFactor}`);
  })
  .build();
