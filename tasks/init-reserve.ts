import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Wires a new asset into the deployed Aave V3 stack:
//   1. Deploy a MockAggregator at the given USD price (8-decimal)
//   2. AaveOracle.setAssetSources([asset], [aggregator])
//   3. PoolConfigurator.initReserves([{...input}]) — clones AToken + VToken
//      via the implementations + calls initialize on each
//   4. PoolConfigurator.setReserveBorrowing(asset, true)
//   5. PoolConfigurator.configureReserveAsCollateral(asset, ltv, liqThreshold, liqBonus)
//   6. ATA warmup: ensure_token_account(aToken) on the cached wrapper
//      so subsequent supply() calls don't trip on balanceOf-of-aToken.
//      Auto-detected via selector probe (0x5e094743); plain ERC20s skipped.
//
// Idempotent: if the reserve already exists (Pool.getReserveData != zero
// aToken), the asset-source + collateral config are still re-applied
// (cheap, parameter changes are common). InitReserves itself reverts on
// already-existing reserves.

const ENSURE_TOKEN_ACCOUNT_SELECTOR = "0x5e094743";

export default task("init-reserve", "Initialize a single Aave reserve (asset listing)")
  .addOption({ name: "asset", description: "Reserve underlying asset address", defaultValue: "" })
  .addOption({ name: "symbol", description: "Symbol used to build aToken/vToken names (e.g., wUSDC)", defaultValue: "" })
  .addOption({ name: "decimals", description: "Decimals of the underlying asset", defaultValue: "" })
  .addOption({ name: "priceUsd", description: "USD price for the MockAggregator (e.g., 1.0 for stablecoins, 3000 for ETH)", defaultValue: "" })
  .addOption({ name: "ltv", description: "Loan-to-value (bps). Default 7500 (75%).", defaultValue: "7500" })
  .addOption({ name: "liquidationThreshold", description: "Liquidation threshold (bps). Default 8000 (80%).", defaultValue: "8000" })
  .addOption({ name: "liquidationBonus", description: "Liquidation bonus (bps over 10000). Default 10500 (5% bonus).", defaultValue: "10500" })
  .setInlineAction(async ({ asset, symbol, decimals, priceUsd, ltv, liquidationThreshold, liquidationBonus }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    if (!asset || !symbol || !decimals || !priceUsd) {
      throw new Error("--asset, --symbol, --decimals, and --price-usd are required");
    }

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}. Run \`hardhat deploy --network ${networkSlug}\` first.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

    const providerAddr = deployments.PoolAddressesProvider.address;
    const configAddr = deployments.PoolConfigurator.address;
    const poolAddr = deployments.Pool.address;
    const oracleAddr = deployments.AaveOracle.address;
    const aTokenImplAddr = deployments.ATokenImpl.address;
    const vTokenImplAddr = deployments.VariableDebtTokenImpl.address;
    const irsAddr = deployments.DefaultReserveInterestRateStrategyV2.address;
    const irsCfg = deployments._config.irs;

    console.log(`Network: ${networkSlug}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`Reserve: ${symbol} @ ${asset}`);

    const decimalsNum = parseInt(String(decimals), 10);
    const ltvBps = parseInt(String(ltv), 10);
    const liqThreshBps = parseInt(String(liquidationThreshold), 10);
    const liqBonusBps = parseInt(String(liquidationBonus), 10);
    // 8-decimal price (AaveOracle BASE_CURRENCY_UNIT = 1e8)
    const priceScaled = BigInt(Math.round(parseFloat(String(priceUsd)) * 1e8));

    const provider = await ethers.getContractAt("PoolAddressesProvider", providerAddr);
    const config = await ethers.getContractAt("PoolConfigurator", configAddr);
    const pool = await ethers.getContractAt("Pool", poolAddr);
    const oracle = await ethers.getContractAt("AaveOracle", oracleAddr);

    // 1. Deploy MockAggregator with the given USD price
    const MockAggregator = await ethers.getContractFactory("MockAggregator");
    const aggregator = await MockAggregator.deploy(priceScaled);
    await aggregator.waitForDeployment();
    const aggAddr = await aggregator.getAddress();
    console.log(`  MockAggregator @ $${priceUsd}: ${aggAddr}`);

    // 2. Wire it into the oracle (overwrites if existing)
    let tx = await oracle.setAssetSources([asset], [aggAddr]);
    await tx.wait();
    console.log(`  oracle.setAssetSources: PASS`);

    // 3. initReserves — encode interestRateData as
    //    abi.encode(InterestRateData(optimalUsageRatio, base, slope1, slope2))
    const interestRateData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint16,uint32,uint32,uint32)"],
      [[irsCfg.optimalUsageRatio, irsCfg.baseVariableBorrowRate, irsCfg.variableRateSlope1, irsCfg.variableRateSlope2]],
    );

    const reserveData = await pool.getReserveData(asset);
    const alreadyInitialized = reserveData.aTokenAddress !== ethers.ZeroAddress;
    if (!alreadyInitialized) {
      const input = {
        aTokenImpl: aTokenImplAddr,
        variableDebtTokenImpl: vTokenImplAddr,
        underlyingAsset: asset,
        aTokenName: `Aave Rome ${symbol}`,
        aTokenSymbol: `a${symbol}`,
        variableDebtTokenName: `Aave Rome Variable Debt ${symbol}`,
        variableDebtTokenSymbol: `vd${symbol}`,
        params: "0x",
        interestRateData,
      };
      tx = await config.initReserves([input]);
      await tx.wait();
      console.log(`  initReserves: PASS`);
    } else {
      console.log(`  reserve already initialized (aToken ${reserveData.aTokenAddress}); skipping initReserves`);
    }

    // Fetch the now-deployed aToken + vToken addresses
    const data = await pool.getReserveData(asset);
    const aTokenAddr: string = data.aTokenAddress;
    const vTokenAddr: string = data.variableDebtTokenAddress;
    console.log(`  aToken: ${aTokenAddr}`);
    console.log(`  vToken: ${vTokenAddr}`);

    // 4. Enable borrowing + flash loans
    tx = await config.setReserveBorrowing(asset, true);
    await tx.wait();
    console.log(`  setReserveBorrowing(true): PASS`);
    tx = await config.setReserveFlashLoaning(asset, true);
    await tx.wait();
    console.log(`  setReserveFlashLoaning(true): PASS`);

    // 5. Configure as collateral
    tx = await config.configureReserveAsCollateral(asset, ltvBps, liqThreshBps, liqBonusBps);
    await tx.wait();
    console.log(`  configureReserveAsCollateral(${ltvBps}/${liqThreshBps}/${liqBonusBps}): PASS`);

    // 6. ATA warmup: aToken needs ensure_token_account(aToken) on cached wrapper.
    // The aToken is where supply() lands the underlying tokens; Pool reads
    // IERC20(asset).balanceOf(aToken) in liquidity-index updates and flashloan
    // accounting. Cached wrapper reverts on uninitialized ATA, same as V3 Uniswap.
    const probeData = ENSURE_TOKEN_ACCOUNT_SELECTOR + signer.address.slice(2).padStart(64, "0");
    try {
      await ethers.provider.call({ to: asset, data: probeData });
    } catch {
      console.log(`  ATA warmup: SKIP (plain ERC20, no ensure_token_account)`);
      console.log(`\nReserve ${symbol} ready at ${aTokenAddr}`);
      return;
    }
    const wrapper = new ethers.Contract(
      asset,
      ["function ensure_token_account(address) returns (bytes32)"],
      signer,
    );
    tx = await wrapper.ensure_token_account(aTokenAddr);
    await tx.wait();
    console.log(`  wrapper.ensure_token_account(aToken=${aTokenAddr}): PASS`);

    // Update the deployments file with the reserve entry
    if (!deployments._reserves) deployments._reserves = {};
    deployments._reserves[symbol] = {
      asset,
      aToken: aTokenAddr,
      vToken: vTokenAddr,
      mockAggregator: aggAddr,
      priceUsd: parseFloat(String(priceUsd)),
      ltv: ltvBps,
      liquidationThreshold: liqThreshBps,
      liquidationBonus: liqBonusBps,
      decimals: decimalsNum,
      initializedAt: new Date().toISOString(),
    };
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n", "utf8");

    console.log(`\nReserve ${symbol} ready.`);
  })
  .build();
