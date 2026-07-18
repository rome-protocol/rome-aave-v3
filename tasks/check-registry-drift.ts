import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Read-only drift check. Compares the local deploy artifact
// (deployments/<network>.json) against the canonical Rome registry
// (apps/aave/<chainId>-<slug>.json + chains/<chainId>-<slug>/contracts.json)
// AND against the live on-chain oracle sources. Reports every mismatch and
// fails (non-zero exit) on any drift, so it can gate CI / a pre-publish check.
//
// The registry is a sibling checkout; locate it via --registry,
// $ROME_REGISTRY_DIR, or ../registry / ../../registry (worktree vs main).
//
//   npx hardhat check-registry-drift --network hadrian [--registry <path>]

const AAVE_ORACLE_ABI = ["function getSourceOfAsset(address) view returns (address)"];

const lc = (s: unknown) => (typeof s === "string" ? s.toLowerCase() : s);

function resolveRegistryDir(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.ROME_REGISTRY_DIR,
    path.resolve(process.cwd(), "../registry"),
    path.resolve(process.cwd(), "../../registry"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "chains")) && fs.existsSync(path.join(c, "apps"))) return c;
  }
  return null;
}

const liveVersion = (entry: any) => entry?.versions?.find((v: any) => v.status === "live");

export default task("check-registry-drift", "Compare deployments/<net>.json + live chain against the Rome registry")
  .addOption({
    name: "registry",
    description: "Path to the rome registry checkout (default: $ROME_REGISTRY_DIR, then ../registry, ../../registry)",
    defaultValue: "",
  })
  .setInlineAction(async ({ registry }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const slug = networkName ?? "unknown";
    const { chainId: chainIdBn } = await ethers.provider.getNetwork();
    const chainId = Number(chainIdBn);
    const idSlug = `${chainId}-${slug}`;

    const depPath = path.join("deployments", `${slug}.json`);
    if (!fs.existsSync(depPath)) throw new Error(`No deployments file at ${depPath}`);
    const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));

    const regDir = resolveRegistryDir(String(registry) || undefined);
    if (!regDir) {
      console.log("⚠ registry checkout not found (tried --registry, $ROME_REGISTRY_DIR, ../registry, ../../registry).");
      console.log("  Pass --registry <path> to enable the comparison. Skipping (not a failure).");
      return;
    }

    const appPath = path.join(regDir, "apps", "aave", `${idSlug}.json`);
    const contractsPath = path.join(regDir, "chains", idSlug, "contracts.json");
    console.log(`Registry:     ${regDir}`);
    console.log(`Chain:        ${idSlug}  (live chainId ${chainId})`);
    console.log(`Deployments:  ${depPath}\n`);

    const drifts: string[] = [];
    const unverified: string[] = [];
    const ok = (label: string, msg = "") => console.log(`  ✓ ${label}${msg ? "  " + msg : ""}`);
    const drift = (label: string, detail: string) => {
      console.log(`  ✗ DRIFT ${label}  ${detail}`);
      drifts.push(`${label}: ${detail}`);
    };
    const cmp = (label: string, a: any, b: any) =>
      lc(a) === lc(b) ? ok(label, `${a}`) : drift(label, `deployments=${a ?? "—"} registry=${b ?? "—"}`);

    // A. core Aave addresses + reserves — deployments ↔ apps/aave
    let app: any;
    if (fs.existsSync(appPath)) {
      app = JSON.parse(fs.readFileSync(appPath, "utf8"));
      console.log("A. core addresses — deployments ↔ apps/aave:");
      cmp("Pool", dep.Pool?.address, app.pool);
      cmp("PoolAddressesProvider", dep.PoolAddressesProvider?.address, app.addressesProvider);
      cmp("AaveOracle", dep.AaveOracle?.address, app.oracle);
      cmp("ACLManager", dep.ACLManager?.address, app.aclManager);
      cmp("PoolConfigurator", dep.PoolConfigurator?.address, app.poolConfigurator);
      cmp("AaveProtocolDataProvider", dep.AaveProtocolDataProvider?.address, app.poolDataProvider);

      console.log("\nB. reserves — deployments._reserves ↔ apps/aave.reserves:");
      const appReserves: Record<string, any> = {};
      for (const r of app.reserves ?? []) appReserves[r.symbol] = r;
      for (const [sym, r] of Object.entries<any>(dep._reserves ?? {})) {
        const ar = appReserves[sym];
        if (!ar) { drift(`reserve ${sym}`, "missing in registry apps/aave"); continue; }
        cmp(`${sym}.underlying`, r.asset, ar.underlying);
        cmp(`${sym}.aToken`, r.aToken, ar.aToken);
        cmp(`${sym}.vToken`, r.vToken, ar.variableDebtToken);
      }
    } else {
      drift("apps/aave", `missing file ${appPath}`);
    }

    // C. core Aave addresses — deployments ↔ chains/contracts.json (live versions)
    console.log("\nC. core addresses — deployments ↔ chains/contracts.json (live):");
    if (fs.existsSync(contractsPath)) {
      const byName: Record<string, any> = {};
      for (const c of JSON.parse(fs.readFileSync(contractsPath, "utf8"))) byName[c.name] = liveVersion(c);
      const map: Array<[string, any, string]> = [
        ["Pool", dep.Pool?.address, "AavePool"],
        ["PoolAddressesProvider", dep.PoolAddressesProvider?.address, "PoolAddressesProvider"],
        ["AaveOracle", dep.AaveOracle?.address, "AaveOracle"],
        ["ACLManager", dep.ACLManager?.address, "ACLManager"],
        ["PoolConfigurator", dep.PoolConfigurator?.address, "PoolConfigurator"],
        ["AaveProtocolDataProvider", dep.AaveProtocolDataProvider?.address, "AaveProtocolDataProvider"],
      ];
      for (const [label, depAddr, regName] of map) {
        const rv = byName[regName];
        if (!rv) { drift(`${label} (contracts.json)`, `no live "${regName}" entry`); continue; }
        cmp(`${label} (contracts.json)`, depAddr, rv.address);
      }
    } else {
      console.log(`  (chains/contracts.json not found at ${contractsPath} — skipped)`);
    }

    // D. live on-chain oracle source — getSourceOfAsset ↔ apps/aave.priceFeed
    if (app && dep.AaveOracle?.address) {
      const appReserves: Record<string, any> = {};
      for (const r of app.reserves ?? []) appReserves[r.symbol] = r;
      const oracle = new ethers.Contract(dep.AaveOracle.address, AAVE_ORACLE_ABI, ethers.provider);
      console.log("\nD. live oracle source — chain.getSourceOfAsset ↔ apps/aave.priceFeed:");
      for (const [sym, r] of Object.entries<any>(dep._reserves ?? {})) {
        const ar = appReserves[sym];
        if (!ar) continue;
        let liveSrc: string;
        try {
          liveSrc = await oracle.getSourceOfAsset(r.asset);
        } catch (e: any) {
          const msg = e?.shortMessage ?? e?.message ?? String(e);
          console.log(`  ⚠ UNVERIFIED ${sym} oracle source — live read failed (likely transient RPC): ${msg}`);
          unverified.push(`${sym} oracle source`);
          continue;
        }
        if (lc(liveSrc) === lc(ar.priceFeed)) {
          ok(`${sym} oracle source`, `${liveSrc} (kind=${ar.priceFeedKind})`);
        } else {
          drift(
            `${sym} oracle source`,
            `chain=${liveSrc} registry.priceFeed=${ar.priceFeed} (registry kind="${ar.priceFeedKind}" — registry likely stale vs an OG-V2 migration)`,
          );
        }
      }
    }

    console.log(`\n${"=".repeat(64)}`);
    if (unverified.length > 0) {
      console.log(`⚠ ${unverified.length} check(s) UNVERIFIED (live read failed, likely transient RPC): ${unverified.join(", ")}`);
      console.log("  Re-run when the RPC is healthy to confirm these.");
    }
    if (drifts.length === 0) {
      console.log(`✓ No confirmed drift: deployments + live chain match the registry for ${idSlug}.`);
      return;
    }
    console.log(`✗ ${drifts.length} confirmed drift(s) for ${idSlug} — reconcile via /publish-registry-pr.`);
    console.log("  Note: oracle.json + the OG-V2 entries in contracts.json are auto-PR'd from rome-solidity;");
    console.log("  fix oracle-source drift there or in apps/aave — never hand-edit oracle.json.");
    throw new Error(`Registry drift: ${drifts.length} confirmed mismatch(es) for ${idSlug} (see report above)`);
  })
  .build();
