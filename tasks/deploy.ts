import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Deploys the canonical Aave V3 slim-cut on a Rome chain:
//   1. PoolAddressesProvider(marketId, owner) — single source of truth
//   2. ACLManager(provider) — wired as ACL_ADMIN
//   3. DefaultReserveInterestRateStrategyV2(provider) — one IRS for the pool
//      (this is V3.6 design — see PoolInstance constructor)
//   4. PoolInstance impl + provider.setPoolImpl() — deploys proxy + initializes
//   5. PoolConfiguratorInstance impl + provider.setPoolConfiguratorImpl()
//   6. ATokenInstance impl (proto-clone via initReserves)
//   7. VariableDebtTokenInstance impl (proto-clone via initReserves)
//   8. AaveProtocolDataProvider(provider) — view helper
//
// Reserves (asset listings + price feeds) are NOT initialized here.
// Use `hardhat init-reserve` per (asset, price) tuple to wire each
// reserve after the stack is up.
//
// Compiler: solc 0.8.27 + optimizer.runs=200 + evm_version=shanghai
// + bytecodeHash:none — matches Aave foundry.toml.
export default task("deploy", "Deploy canonical Aave V3 slim-cut stack")
  .addOption({
    name: "marketId",
    description: "Identifier passed to PoolAddressesProvider. Default 'Rome Aave V3 Market'.",
    defaultValue: "Rome Aave V3 Market",
  })
  .addOption({
    name: "optimalUsageRatio",
    description: "Pool-wide IRS optimal usage ratio (bps). Default 8000 (80%).",
    defaultValue: "8000",
  })
  .addOption({
    name: "baseVariableBorrowRate",
    description: "Pool-wide IRS base variable borrow rate (bps). Default 0.",
    defaultValue: "0",
  })
  .addOption({
    name: "variableRateSlope1",
    description: "Pool-wide IRS variable rate slope before kink (bps). Default 400 (4%).",
    defaultValue: "400",
  })
  .addOption({
    name: "variableRateSlope2",
    description: "Pool-wide IRS variable rate slope after kink (bps). Default 7500 (75%).",
    defaultValue: "7500",
  })
  .setInlineAction(async ({ marketId, optimalUsageRatio, baseVariableBorrowRate, variableRateSlope1, variableRateSlope2 }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [deployer] = await ethers.getSigners();
    const recipient = deployer.address;
    console.log(`Network:  ${networkName}`);
    console.log(`Deployer: ${recipient}`);
    console.log(`Market:   ${marketId}`);

    const deployedAt = new Date().toISOString();

    // 1. PoolAddressesProvider
    const PoolAddressesProvider = await ethers.getContractFactory("PoolAddressesProvider");
    const provider = await PoolAddressesProvider.deploy(marketId, recipient);
    await provider.waitForDeployment();
    const providerAddr = await provider.getAddress();
    console.log(`PoolAddressesProvider: ${providerAddr}`);

    // 2. ACLManager — must be set BEFORE setACLAdmin (ACLManager constructor
    // calls provider.getACLAdmin which would revert if ACL_ADMIN was unset
    // and we set ACL_MANAGER before ACL_ADMIN).
    // Aave's deploy script sets ACL_ADMIN first, then deploys + wires ACLManager.
    let tx = await provider.setACLAdmin(recipient);
    await tx.wait();

    const ACLManager = await ethers.getContractFactory("ACLManager");
    const aclManager = await ACLManager.deploy(providerAddr);
    await aclManager.waitForDeployment();
    const aclManagerAddr = await aclManager.getAddress();
    tx = await provider.setACLManager(aclManagerAddr);
    await tx.wait();
    console.log(`ACLManager: ${aclManagerAddr}`);

    // Grant deployer the POOL_ADMIN + ASSET_LISTING_ADMIN + EMERGENCY_ADMIN roles
    tx = await aclManager.addPoolAdmin(recipient);
    await tx.wait();
    tx = await aclManager.addAssetListingAdmin(recipient);
    await tx.wait();
    tx = await aclManager.addEmergencyAdmin(recipient);
    await tx.wait();

    // 3. Interest rate strategy — pool-wide in V3.6
    const IRS = await ethers.getContractFactory("DefaultReserveInterestRateStrategyV2");
    const irs = await IRS.deploy(providerAddr);
    await irs.waitForDeployment();
    const irsAddr = await irs.getAddress();
    console.log(`DefaultReserveInterestRateStrategyV2: ${irsAddr}`);

    // 4. Pool implementation needs 5 logic libraries linked.
    // These are external (non-internal) Solidity libraries — Aave compiles
    // them into separate contracts to keep Pool bytecode under the 24KB
    // EIP-170 limit. Library deps within the set:
    //   - FlashLoanLogic depends on BorrowLogic
    //   - Others are stand-alone
    // Deploy in dependency order, threading earlier addresses into later
    // factories.
    const libraries: Record<string, string> = {};
    async function deployLib(name: string, deps: string[] = []) {
      const linkLibs: Record<string, string> = {};
      for (const d of deps) linkLibs[d] = libraries[d];
      const factory = deps.length
        ? await ethers.getContractFactory(name, { libraries: linkLibs })
        : await ethers.getContractFactory(name);
      const lib = await factory.deploy();
      await lib.waitForDeployment();
      libraries[name] = await lib.getAddress();
      console.log(`  lib ${name}: ${libraries[name]}`);
    }
    await deployLib("BorrowLogic");
    await deployLib("SupplyLogic");
    await deployLib("LiquidationLogic");
    await deployLib("PoolLogic");
    await deployLib("FlashLoanLogic", ["BorrowLogic"]);
    const PoolInstance = await ethers.getContractFactory("PoolInstance", { libraries });
    const poolImpl = await PoolInstance.deploy(providerAddr, irsAddr);
    await poolImpl.waitForDeployment();
    const poolImplAddr = await poolImpl.getAddress();
    tx = await provider.setPoolImpl(poolImplAddr);
    await tx.wait();
    const poolAddr: string = await provider.getPool();
    console.log(`Pool (proxy):  ${poolAddr}`);
    console.log(`Pool (impl):   ${poolImplAddr}`);

    // 5. PoolConfigurator implementation + provider sets it.
    // Needs ConfiguratorLogic linked.
    await deployLib("ConfiguratorLogic");
    const PoolConfiguratorInstance = await ethers.getContractFactory(
      "PoolConfiguratorInstance",
      { libraries: { ConfiguratorLogic: libraries.ConfiguratorLogic } },
    );
    const configImpl = await PoolConfiguratorInstance.deploy();
    await configImpl.waitForDeployment();
    const configImplAddr = await configImpl.getAddress();
    tx = await provider.setPoolConfiguratorImpl(configImplAddr);
    await tx.wait();
    const configAddr: string = await provider.getPoolConfigurator();
    console.log(`PoolConfigurator (proxy): ${configAddr}`);
    console.log(`PoolConfigurator (impl):  ${configImplAddr}`);

    // 6. AToken implementation (per-reserve clones initialized via initReserves).
    // Constructor: (IPool pool, address rewardsController, address treasury)
    // rewardsController = 0 is OK (no incentives module in slim cut).
    // treasury MUST be non-zero (AToken constructor enforces) — use deployer
    // as the slim-cut treasury so collected reserve fees flow back to the
    // operator's wallet. Production should swap this for a dedicated
    // Collector / multisig contract.
    const treasury = recipient;
    const ATokenInstance = await ethers.getContractFactory("ATokenInstance");
    const aTokenImpl = await ATokenInstance.deploy(poolAddr, ethers.ZeroAddress, treasury);
    await aTokenImpl.waitForDeployment();
    const aTokenImplAddr = await aTokenImpl.getAddress();
    console.log(`ATokenInstance (impl): ${aTokenImplAddr}`);

    // 7. VariableDebtToken implementation.
    // Constructor: (IPool pool, address rewardsController)
    const VariableDebtTokenInstance = await ethers.getContractFactory("VariableDebtTokenInstance");
    const vTokenImpl = await VariableDebtTokenInstance.deploy(poolAddr, ethers.ZeroAddress);
    await vTokenImpl.waitForDeployment();
    const vTokenImplAddr = await vTokenImpl.getAddress();
    console.log(`VariableDebtTokenInstance (impl): ${vTokenImplAddr}`);

    // 8. Data provider (view helper)
    const AaveProtocolDataProvider = await ethers.getContractFactory("AaveProtocolDataProvider");
    const dataProvider = await AaveProtocolDataProvider.deploy(providerAddr);
    await dataProvider.waitForDeployment();
    const dataProviderAddr = await dataProvider.getAddress();
    tx = await provider.setPoolDataProvider(dataProviderAddr);
    await tx.wait();
    console.log(`AaveProtocolDataProvider: ${dataProviderAddr}`);

    // 9. Empty AaveOracle with base currency = USD (canonical Aave convention)
    // Real assets + price sources are added via `hardhat init-reserve`.
    const USD_BASE_CURRENCY = ethers.ZeroAddress;
    const USD_BASE_CURRENCY_UNIT = 100_000_000n; // 8 decimals
    const AaveOracle = await ethers.getContractFactory("AaveOracle");
    const oracle = await AaveOracle.deploy(
      providerAddr,
      [],
      [],
      ethers.ZeroAddress,
      USD_BASE_CURRENCY,
      USD_BASE_CURRENCY_UNIT,
    );
    await oracle.waitForDeployment();
    const oracleAddr = await oracle.getAddress();
    tx = await provider.setPriceOracle(oracleAddr);
    await tx.wait();
    console.log(`AaveOracle: ${oracleAddr}`);

    // Persist IRS config so init-reserve can replay it as `interestRateData` per reserve
    const irsConfig = {
      optimalUsageRatio: parseInt(String(optimalUsageRatio), 10),
      baseVariableBorrowRate: parseInt(String(baseVariableBorrowRate), 10),
      variableRateSlope1: parseInt(String(variableRateSlope1), 10),
      variableRateSlope2: parseInt(String(variableRateSlope2), 10),
    };

    const deploymentsDir = "deployments";
    if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
    const networkSlug = networkName ?? "unknown";
    const networkFilePath = path.join(deploymentsDir, `${networkSlug}.json`);
    const deployments = {
      PoolAddressesProvider: { address: providerAddr, deployedAt, marketId },
      ACLManager: { address: aclManagerAddr, deployedAt },
      DefaultReserveInterestRateStrategyV2: { address: irsAddr, deployedAt },
      Pool: { address: poolAddr, deployedAt, impl: poolImplAddr },
      PoolConfigurator: { address: configAddr, deployedAt, impl: configImplAddr },
      ATokenImpl: { address: aTokenImplAddr, deployedAt },
      VariableDebtTokenImpl: { address: vTokenImplAddr, deployedAt },
      AaveProtocolDataProvider: { address: dataProviderAddr, deployedAt },
      AaveOracle: {
        address: oracleAddr,
        deployedAt,
        baseCurrency: USD_BASE_CURRENCY,
        baseCurrencyUnit: USD_BASE_CURRENCY_UNIT.toString(),
      },
      _config: { irs: irsConfig },
    };

    fs.writeFileSync(networkFilePath, JSON.stringify(deployments, null, 2) + "\n", "utf8");
    console.log(`Deployments written to ${networkFilePath}`);
  })
  .build();
