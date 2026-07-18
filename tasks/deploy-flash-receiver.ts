import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Deploys PreApprovedMultiFlashReceiver, calls init() on it for every cached
// SPL wrapper listed in deployments/<network>.json#_reserves, verifies
// allowances landed at MaxUint256, and writes the resulting address back to
// the deployments file under `PreApprovedMultiFlashReceiver`.
//
// Idempotent: if a receiver is already registered in the deployments file,
// re-runs verify its allowances and re-init any that are not at max.
//
// Background: Aave V3's canonical flash loan receiver pattern calls
// `IERC20(asset).approve(POOL, amount + premium)` inside `executeOperation`.
// On Rome that in-callback approve pushes the per-sig account count past the
// cached-wrapper composition limit for 2+ cached SPL wrappers. The pre-approve
// pattern moves the approve into a separate setup tx so the flash loan tx
// stays under the limit. See `CLAUDE.md § Multi-asset Flash Loan Pattern`
// and `PreApprovedFlashReceiverBase.sol`.

// DemoOpenMultiFlashReceiver has NO initiator check — anyone can call
// Pool.flashLoan against it. It must only ever exist on a Rome testnet/demo
// chain. Default-deny: deploying the demo variant against a chainId not in this
// allowlist hard-fails. Add a new Rome testnet/demo chainId here when standing
// up its public demo — NEVER add a mainnet chainId.
const DEMO_RECEIVER_TESTNET_CHAIN_IDS = new Set<number>([
  30001, // aurelius (Rome real-testnet / Solana testnet)
  200001, // augustus (Rome testnet / Solana devnet)
  121301, // marcus   (Rome devnet / Solana devnet)
  200010, // hadrian  (Rome testnet / Solana devnet)
]);

export default task("deploy-flash-receiver", "Deploy + init the pre-approved multi-asset flash loan receiver")
  .addOption({ name: "force", description: "Re-deploy even if a receiver is already registered", defaultValue: "false" })
  .addOption({ name: "demo", description: "Deploy DemoOpenMultiFlashReceiver (no initiator check — testnet/demo only) instead of the production-hardened PreApprovedMultiFlashReceiver", defaultValue: "false" })
  .setInlineAction(async ({ force, demo }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const slug = networkName ?? "unknown";
    const isDemoVariant = String(demo).toLowerCase() === "true";

    // Refuse the no-initiator demo receiver outside the testnet/demo allowlist,
    // checked against the LIVE chainId (not the config label, which could be
    // mislabeled). Fails before any key use or deploy.
    if (isDemoVariant) {
      const { chainId } = await ethers.provider.getNetwork();
      if (!DEMO_RECEIVER_TESTNET_CHAIN_IDS.has(Number(chainId))) {
        throw new Error(
          `Refusing to deploy DemoOpenMultiFlashReceiver (no initiator check) on chainId ${chainId} (${slug}). ` +
            `It is testnet/demo-only. If ${chainId} is a Rome testnet/demo chain, add it to ` +
            `DEMO_RECEIVER_TESTNET_CHAIN_IDS in tasks/deploy-flash-receiver.ts — NEVER add a mainnet chainId. ` +
            `Production must use the hardened PreApprovedMultiFlashReceiver (the default; omit --demo).`,
        );
      }
    }

    const [signer] = await ethers.getSigners();

    const deploymentsPath = path.join("deployments", `${slug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const providerAddr = deployments.PoolAddressesProvider?.address;
    const poolAddr = deployments.Pool?.address;
    if (!providerAddr || !poolAddr) throw new Error("Pool/PoolAddressesProvider missing");

    const reserves = deployments._reserves ?? {};
    const reserveAssets = Object.values(reserves).map((r: any) => r.asset);
    if (reserveAssets.length === 0) {
      throw new Error("No reserves found — run init-reserve first");
    }

    console.log(`Network:                ${slug}`);
    console.log(`Signer:                 ${signer.address}`);
    console.log(`PoolAddressesProvider:  ${providerAddr}`);
    console.log(`Pool:                   ${poolAddr}`);
    console.log(`Reserve assets:         ${reserveAssets.length}`);
    console.log();

    const forceRedeploy = String(force).toLowerCase() === "true";
    const contractName = isDemoVariant ? "DemoOpenMultiFlashReceiver" : "PreApprovedMultiFlashReceiver";
    const deploymentKey = isDemoVariant ? "DemoOpenMultiFlashReceiver" : "PreApprovedMultiFlashReceiver";
    if (isDemoVariant) {
      console.log(`⚠️  DEMO variant: receiver has NO initiator check — anyone can call Pool.flashLoan against it`);
      console.log(`    Use only on testnet / for public demos. Production: use the default (production-hardened) variant.`);
      console.log();
    }
    let receiverAddr: string;
    let isFreshDeploy = false;

    if (deployments[deploymentKey]?.address && !forceRedeploy) {
      receiverAddr = deployments[deploymentKey].address;
      console.log(`Existing ${contractName}: ${receiverAddr} (reusing; pass --force to redeploy)`);
    } else {
      const Factory = await ethers.getContractFactory(contractName);
      const c = await Factory.deploy(providerAddr);
      await c.waitForDeployment();
      receiverAddr = await c.getAddress();
      isFreshDeploy = true;
      console.log(`Deployed ${contractName}: ${receiverAddr}`);
    }

    // Warm receiver's ATAs on each cached wrapper (idempotent for plain ERC20).
    const cachedProbeData = "0x5e094743" + signer.address.slice(2).padStart(64, "0");
    async function maybeWarmATA(asset: string): Promise<void> {
      try {
        await ethers.provider.call({ to: asset, data: cachedProbeData });
      } catch {
        return; // plain ERC20 — no ATA warmup needed
      }
      const wrapper = new ethers.Contract(asset, ["function ensure_token_account(address) returns (bytes32)"], signer);
      const tx = await wrapper.ensure_token_account(receiverAddr);
      await tx.wait();
    }
    for (const asset of reserveAssets) {
      await maybeWarmATA(asset);
    }
    console.log(`ATAs warmed for all ${reserveAssets.length} cached wrappers (plain ERC20s skipped)`);

    // Find which assets actually need init (allowance < MaxUint256).
    const erc20 = new ethers.Contract(reserveAssets[0], ["function allowance(address,address) view returns (uint256)"], signer);
    const MAX = (1n << 256n) - 1n;
    const needInit: string[] = [];
    for (const asset of reserveAssets) {
      const t = erc20.attach(asset) as any;
      const allowance: bigint = await t.allowance(receiverAddr, poolAddr);
      const needs = allowance < MAX / 2n; // sentinel for "not pre-approved"
      console.log(`  ${asset}: allowance=${allowance >= MAX / 2n ? "MAX" : allowance.toString()}${needs ? " — will init" : ""}`);
      if (needs) needInit.push(asset);
    }

    if (needInit.length > 0) {
      const receiver = await ethers.getContractAt(contractName, receiverAddr);
      console.log();
      console.log(`Calling receiver.init([${needInit.length} assets])…`);
      const tx = await receiver.init(needInit);
      const rc = await tx.wait();
      console.log(`  init tx=${tx.hash} status=${rc?.status}`);
    } else {
      console.log(`  all assets already pre-approved — nothing to do`);
    }

    deployments[deploymentKey] = {
      address: receiverAddr,
      deployedAt: isFreshDeploy ? new Date().toISOString() : deployments[deploymentKey]?.deployedAt,
      initializedAssets: reserveAssets,
      ctor: { addressesProvider: providerAddr },
      ...(isDemoVariant ? { warning: "Demo-only — no initiator check. Anyone can call Pool.flashLoan against this." } : {}),
    };
    fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2) + "\n");
    console.log();
    console.log(`Wrote receiver address to ${deploymentsPath}`);
  })
  .build();
