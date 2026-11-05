// Set the supply cap and borrow cap (WHOLE tokens, 0 = no cap) for one reserve through PoolConfigurator,
// and print AaveProtocolDataProvider.getReserveCaps before and after.
//
//   ASSET=wBTC SUPPLY_CAP=1 BORROW_CAP=1 npx hardhat run scripts/set-reserve-caps.ts --network hadrian
//
// ASSET is a symbol (wUSDC / wETH / wSOL / wBTC) or a 0x address. The signer must be a pool admin or risk admin.
//
// DRY_RUN=1 sends nothing and needs no key: it prints the two transactions it would send and eth_calls each
// one from FROM (default: the deployer recorded in deployments/hadrian-oracle-shims.json) with BOTH eth_call and
// eth_estimateGas (eth_call alone skips the proxy's account limit), then checks that
// FROM holds the pool-admin / risk-admin role. A reserve that is not listed yet reverts in the dry run with
// AssetNotListed (the real run does too): list it first (init-reserve).
//   DRY_RUN=1 ASSET=wBTC SUPPLY_CAP=1 BORROW_CAP=1 npx hardhat run scripts/set-reserve-caps.ts
// Optional env: RPC_URL, FROM (dry run only).
import { ethers } from "ethers";
import { loadDeployments, readJson } from "./lib/oracle-common.js";
import { env, RPC_URL, DATA_PROVIDER_ABI, resolveAsset, preflight } from "./lib/listing-common.js";

const CFG_ABI = [
  "function setSupplyCap(address asset, uint256 newSupplyCap)",
  "function setBorrowCap(address asset, uint256 newBorrowCap)",
];
const ACL_ABI = ["function isPoolAdmin(address) view returns (bool)", "function isRiskAdmin(address) view returns (bool)"];
// Aave's MAX_VALID_SUPPLY_CAP / MAX_VALID_BORROW_CAP (ReserveConfiguration): 2^36 - 1 whole tokens.
const MAX_CAP = (1n << 36n) - 1n;

const capArg = (k: string): bigint => {
  const v = env(k);
  if (!/^\d+$/.test(v)) throw new Error(`set ${k}=<whole tokens, integer; 0 = no cap>`);
  const n = BigInt(v);
  if (n > MAX_CAP) throw new Error(`${k}=${v} is above Aave's maximum cap ${MAX_CAP}`);
  return n;
};

async function printCaps(label: string, dp: ethers.Contract, asset: string) {
  const [borrowCap, supplyCap] = await dp.getReserveCaps(asset);
  console.log(`  ${label}: supplyCap=${supplyCap} borrowCap=${borrowCap} (whole tokens, 0 = no cap)`);
}

async function main() {
  const assetIn = env("ASSET");
  if (!assetIn) throw new Error("set ASSET=<symbol or 0x address> SUPPLY_CAP=<n> BORROW_CAP=<n>");
  const { symbol, address: asset } = resolveAsset(assetIn);
  const supplyCap = capArg("SUPPLY_CAP"), borrowCap = capArg("BORROW_CAP");
  const dryRun = /^(1|true|yes)$/i.test(env("DRY_RUN"));

  const dep = loadDeployments();
  const provider = new ethers.JsonRpcProvider(RPC_URL());
  const dp = new ethers.Contract(dep.AaveProtocolDataProvider.address, DATA_PROVIDER_ABI, provider);
  const cfgIface = new ethers.Interface(CFG_ABI);
  const cfgAddr: string = dep.PoolConfigurator.address;
  const txs = [
    { name: "setSupplyCap", data: cfgIface.encodeFunctionData("setSupplyCap", [asset, supplyCap]) },
    { name: "setBorrowCap", data: cfgIface.encodeFunctionData("setBorrowCap", [asset, borrowCap]) },
  ];

  console.log(`${symbol} ${asset}  PoolConfigurator ${cfgAddr}`);
  await printCaps("before", dp, asset);

  if (dryRun) {
    const from = env("FROM", readJson("deployments/hadrian-oracle-shims.json").deployer);
    if (!ethers.isAddress(from)) throw new Error(`FROM is not an address: ${from}`);
    const acl = new ethers.Contract(dep.ACLManager.address, ACL_ABI, provider);
    const [pa, ra] = await Promise.all([acl.isPoolAdmin(from), acl.isRiskAdmin(from)]);
    console.log(`DRY RUN, nothing is sent. from ${from}: poolAdmin=${pa} riskAdmin=${ra}${pa || ra ? "" : "  <-- would revert CALLER_NOT_RISK_OR_POOL_ADMIN"}`);
    let bad = 0;
    for (const t of txs) {
      console.log(`  would send ${t.name}: to ${cfgAddr} data ${t.data}`);
      const r = await preflight(provider, { from, to: cfgAddr, data: t.data });
      if (!r.ok) bad++;
      console.log(`    ${r.text}`);
    }
    process.exit(bad ? 2 : 0);
  }

  // Real run: the hardhat network signer (keystore HADRIAN_PRIVATE_KEY). Imported here so a dry run never loads a key.
  const hre = (await import("hardhat")).default;
  const { ethers: hEthers } = await hre.network.connect();
  const [signer] = await hEthers.getSigners();
  console.log(`signer ${signer.address}`);
  const cfg = new ethers.Contract(cfgAddr, CFG_ABI, signer);
  let tx = await cfg.setSupplyCap(asset, supplyCap); console.log(`setSupplyCap(${supplyCap}) tx ${tx.hash}`); await tx.wait();
  tx = await cfg.setBorrowCap(asset, borrowCap); console.log(`setBorrowCap(${borrowCap}) tx ${tx.hash}`); await tx.wait();
  await printCaps("after ", dp, asset);
}
main().catch((e) => { console.error(e); process.exit(1); });
