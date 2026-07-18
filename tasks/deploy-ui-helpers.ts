import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Deploys UiPoolDataProviderV3 — the single-call aggregator the UI uses
// to fetch (a) all reserves + their config + APYs and (b) all user
// per-reserve positions in two RPC calls instead of N×4.
//
// Constructor signature:
//   UiPoolDataProviderV3(
//     AggregatorInterface networkBaseTokenPriceInUsdProxyAggregator,
//     AggregatorInterface marketReferenceCurrencyPriceInUsdProxyAggregator
//   )
//
// On Hadrian we reuse the existing MockAggregators from init-reserve:
//   - networkBaseTokenPriceInUsdProxyAggregator   ← wETH MockAggregator ($3000)
//     (Hadrian's "network base token" — ETH, since wETH is the closest
//      analog to a native gas token; the AaveOracle BASE_CURRENCY is 0x0 =
//      USD reference, so the network base price is reported in USD)
//   - marketReferenceCurrencyPriceInUsdProxyAggregator ← wUSDC MockAggregator ($1)
//     (returns 1e8 = USD/USD = 1.0, matching AaveOracle.BASE_CURRENCY_UNIT)
//
// Appends `UiPoolDataProviderV3.address` to deployments/<network>.json so
// `/publish-registry-pr` can pick it up for the apps/aave/<chainId>-<slug>.json
// follow-up entry.

export default task("deploy-ui-helpers", "Deploy UiPoolDataProviderV3 (and optionally WalletBalanceProvider)")
  .addOption({
    name: "networkBaseAggregator",
    description: "Address of the AggregatorInterface for the network's base token price in USD. Default = the wETH MockAggregator from deployments/<network>.json#_reserves.wETH.mockAggregator.",
    defaultValue: "",
  })
  .addOption({
    name: "marketRefAggregator",
    description: "Address of the AggregatorInterface for the market reference currency (USD) in USD. Default = the wUSDC MockAggregator from deployments/<network>.json#_reserves.wUSDC.mockAggregator.",
    defaultValue: "",
  })
  .setInlineAction(async ({ networkBaseAggregator, marketRefAggregator }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [deployer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}. Run \`hardhat deploy --network ${networkSlug}\` first.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

    const wethReserve = deployments._reserves?.wETH;
    const wusdcReserve = deployments._reserves?.wUSDC;
    const networkBase = networkBaseAggregator || wethReserve?.mockAggregator;
    const marketRef = marketRefAggregator || wusdcReserve?.mockAggregator;
    if (!networkBase) throw new Error("Need --network-base-aggregator or a wETH reserve in deployments to default to");
    if (!marketRef) throw new Error("Need --market-ref-aggregator or a wUSDC reserve in deployments to default to");

    console.log(`Network:    ${networkSlug}`);
    console.log(`Deployer:   ${deployer.address}`);
    console.log(`Network base aggregator (default = wETH): ${networkBase}`);
    console.log(`Market ref aggregator   (default = wUSDC): ${marketRef}`);

    const deployedAt = new Date().toISOString();

    const Factory = await ethers.getContractFactory("UiPoolDataProviderV3");
    const helper = await Factory.deploy(networkBase, marketRef);
    await helper.waitForDeployment();
    const addr = await helper.getAddress();
    console.log(`UiPoolDataProviderV3: ${addr}`);

    deployments.UiPoolDataProviderV3 = {
      address: addr,
      deployedAt,
      ctor: { networkBaseAggregator: networkBase, marketRefAggregator: marketRef },
    };
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log(`Wrote UiPoolDataProviderV3 to ${deploymentsPath}`);

    // Smoke-call: fetch the reserves list — should match Pool.getReservesList().
    const provider = deployments.PoolAddressesProvider?.address;
    if (provider) {
      const ui = await ethers.getContractAt("UiPoolDataProviderV3", addr);
      const reserves = await ui.getReservesList(provider);
      console.log(`  smoke: getReservesList(${provider}) returned ${reserves.length} reserves`);
    }
  })
  .build();
