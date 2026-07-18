import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Deploys 4 plain-ERC20 MockTokens + a Faucet on a Rome chain, funds the
// faucet with native gas (10 × claimsBudget), and registers each token
// with the faucet at a 100-unit drop.
//
// Writes the addresses to deployments/<network>.json under "_faucet" and
// "_mockTokens" so /publish-registry-pr (and the demo) can pick them up.
//
// After this lands, the operator runs `hardhat init-reserve` for each
// mock so they show up in the Aave demo's Markets list.

const MOCK_TOKEN_SPECS: { name: string; symbol: string; decimals: number; drop: number }[] = [
  { name: "Hadrian Heat", symbol: "HEAT", decimals: 18, drop: 100 },
  { name: "Hadrian Salt", symbol: "SALT", decimals: 18, drop: 100 },
  { name: "Hadrian Milk", symbol: "MILK", decimals: 18, drop: 100 },
  { name: "Hadrian Oil",  symbol: "OIL",  decimals: 18, drop: 100 },
];

export default task("deploy-faucet", "Deploy 4 MockTokens + Faucet, register tokens")
  .addOption({
    name: "gasDrop",
    description: "Native gas per claim (whole units, e.g. '10'). Default 10.",
    defaultValue: "10",
  })
  .addOption({
    name: "fundClaims",
    description: "How many user claims to pre-fund the faucet's native balance for. Default 50.",
    defaultValue: "50",
  })
  .setInlineAction(async ({ gasDrop, fundClaims }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [deployer] = await ethers.getSigners();
    const networkSlug = networkName ?? "unknown";

    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    const deployments = fs.existsSync(deploymentsPath)
      ? JSON.parse(fs.readFileSync(deploymentsPath, "utf8"))
      : {};

    const gasDropWei = ethers.parseEther(String(gasDrop));
    const fundWei = gasDropWei * BigInt(parseInt(String(fundClaims), 10));

    console.log(`Network:    ${networkSlug}`);
    console.log(`Deployer:   ${deployer.address}`);
    console.log(`Gas drop:   ${gasDrop} native per claim`);
    console.log(`Funding:    ${ethers.formatEther(fundWei)} native (≈ ${fundClaims} claims)`);

    const Faucet = await ethers.getContractFactory("Faucet");
    const faucet = await Faucet.deploy(gasDropWei, { value: fundWei });
    await faucet.waitForDeployment();
    const faucetAddr = await faucet.getAddress();
    console.log(`Faucet:     ${faucetAddr}`);

    const MockToken = await ethers.getContractFactory("MockToken");
    const mocks: Array<{ symbol: string; name: string; decimals: number; address: string; drop: string }> = [];

    for (const spec of MOCK_TOKEN_SPECS) {
      const token = await MockToken.deploy(spec.name, spec.symbol, spec.decimals, faucetAddr);
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();
      const dropRaw = ethers.parseUnits(String(spec.drop), spec.decimals);
      const addTx = await faucet.addToken(tokenAddr, dropRaw);
      await addTx.wait();
      console.log(`  ${spec.symbol.padEnd(6)} ${tokenAddr}  drop=${spec.drop}`);
      mocks.push({ symbol: spec.symbol, name: spec.name, decimals: spec.decimals, address: tokenAddr, drop: dropRaw.toString() });
    }

    deployments.Faucet = {
      address: faucetAddr,
      deployedAt: new Date().toISOString(),
      gasDropWei: gasDropWei.toString(),
      fundedWei: fundWei.toString(),
    };
    deployments._mockTokens = mocks;
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log(`Wrote Faucet + ${mocks.length} mock tokens to ${deploymentsPath}`);
    console.log(`\nNext: \`hardhat init-reserve --network ${networkSlug}\` for each mock token (--ltv 6000 --liquidation-threshold 7000 --price-usd 1 etc).`);
  })
  .build();
