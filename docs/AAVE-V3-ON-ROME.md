# Aave V3 on Rome

Living documentation for the Aave V3 deployment on Rome (reference chain:
**Hadrian**, `200010`, Rome testnet on Solana devnet substrate). Covers what
runs, how it differs from mainnet Aave, how to deploy it, and the operational
tasks. End-user instructions for the demo UI live in
[`rome-aave-v3-demo/docs/USER-GUIDE.md`](https://github.com/rome-protocol/rome-aave-v3-demo/blob/main/docs/USER-GUIDE.md).

> Addresses below are point-in-time for Hadrian; `deployments/<chain>.json`
> and the registry (`apps/aave/<chainId>-<slug>.json`) are authoritative.

---

## 1. What this is — Aave V3, canonically, on Rome EVM

This is **canonical Aave V3.6**, byte-identical to the upstream
`@aave-dao/aave-v3-origin@3.6.0` source (slim cut), running unmodified inside
Rome's EVM. Same `Pool`, `PoolConfigurator`, `AaveOracle`, aTokens, variable
debt tokens, interest-rate strategy. Compiler matches Aave's foundry.toml:
solc 0.8.27, optimizer runs 200, `evm_version: shanghai`, `bytecodeHash: none`.

The design principle (shared with rome-uniswap-v3, compound-on-rome): **modify
the token, keep the protocol canonical.** Aave's contracts are untouched; the
only Rome-specific pieces sit at the edges:

| Layer | What | Rome-specific? |
|---|---|---|
| Lending protocol | Aave V3.6 Pool + tokens + configurator | **No** — byte-identical mainnet source |
| Reserve underlyings | `SPL_ERC20_cached` wrappers (wUSDC/wETH/wSOL) + mock ERC-20s (HEAT/SALT/MILK/OIL) | The wrappers are Rome (ERC-20 view over a real Solana SPL token) |
| Price oracle | `AaveOracle` reading per-asset sources | Real assets read **live Pyth via OG-V2** (see §5); mock tokens use fixed `MockAggregator`s |
| Flash-loan receivers | user-supplied; demo ships a pre-approved one | Pre-approve pattern is Rome's answer to Solana's account cap (see §6) |

Settlement is Solana-fast; the contracts and JSON-RPC surface are
EVM-canonical, so MetaMask + ethers/viem + the Aave SDK all work as-is.

### Live Hadrian addresses (200010)

| Contract | Address |
|---|---|
| `PoolAddressesProvider` | `0xDba99FC11d7383e722F6DEc181F71560b2780f14` |
| `Pool` | `0x56cD6Bd0FDAd19F44df9D8b9aadD84f964c2fE11` |
| `PoolConfigurator` | `0x0C87be51a3676B5B5d9929C99B3F8496ecBB8B03` |
| `ACLManager` | `0x5E0FDb82A68f3705e93C5384Ccb8ac3e6841bD55` |
| `AaveOracle` | `0x8A7dcF67BBe2BacF6f9d82E14c16B76df6b9DB11` |
| `AaveProtocolDataProvider` | `0xE58Ea21dBF3f117cC8e39895E9Dcb843A31441d4` |

Reserves: **wUSDC, wETH, wSOL** (cached SPL wrappers) + **HEAT, SALT, MILK,
OIL** (mock collateral tokens). The mock tokens are minted by a faucet
(`0xD3f2f2fa8B13e8B25E7c16dCe6566B4921425071`, 100 of each + 10 native gas,
once per address).

---

## 2. Prerequisites

- Node + the repo's hardhat (Hardhat 3). `npm install`.
- A funded deployer key in the hardhat keystore as `HADRIAN_PRIVATE_KEY` (the
  Hadrian deployer = pool admin = `0x1f4946Be340F06c46A50E65084790968aBcc48F6`).
  > Keystore is per-repo. Source the Hadrian key from THIS repo's keystore;
  > rome-solidity's key of the same name resolves to a different address
  > (see the keystore-drift note in the monorepo memory).
- Network config is in `hardhat.config.ts` (`hadrian`, `marcus`, etc.).

All tasks run as `npx hardhat <task> --network hadrian`.

---

## 3. Deploying the protocol from scratch

Order matters — reserves depend on the core stack, the oracle depends on
reserves, flash-loan smoke depends on liquidity.

```bash
# 1. Core stack — PoolAddressesProvider → ACLManager → IRS → Pool (proxy) →
#    PoolConfigurator → aToken/debtToken impls → DataProvider. (8 steps.)
npx hardhat deploy --network hadrian
#    If the proxy preflight trips on Rome (payer-pool / holder contention),
#    use the resume-capable, client-side-signed variant instead:
npx hardhat deploy-resume --network hadrian

# 2. View helper the UI needs for getReservesData / getUserReservesData.
npx hardhat deploy-ui-helpers --network hadrian

# 3. Mock collateral tokens + faucet (HEAT/SALT/MILK/OIL).
npx hardhat deploy-faucet --network hadrian

# 4. List each reserve (asset + price source + risk params). One per asset.
npx hardhat init-reserve --network hadrian --asset <underlying> --price-feed <aggregator> ...

# 5. (optional) Auxiliary view helpers — WalletBalanceProvider + LiquidationDataProvider.
npx hardhat deploy-aux --network hadrian

# 6. (optional) E-mode categories (Stablecoin / Crypto correlated groups).
npx hardhat setup-emodes --network hadrian

# 7. Seed borrow-side liquidity so borrows/flash-loans have funds.
npx hardhat seed-pool --network hadrian
```

Every task writes resulting addresses to `deployments/<network>.json`. Publish
them to the registry via the monorepo `/publish-registry-pr` script
(`apps/aave/<chainId>-<slug>.json` + `chains/<...>/contracts.json`).

---

## 4. Operational tasks (day-2)

| Task / script | What it does |
|---|---|
| `hardhat gamut --network hadrian` | Stress gamut: Aave V3 × cached wrappers (supply/borrow/repay/withdraw across reserves) |
| `hardhat gamut-extras --network hadrian` | Smoke: **multi-asset flashLoan** (pre-approved receiver) + setUserEMode + repayWithATokens. Expect all PASS. |
| `hardhat deploy-flash-receiver --network hadrian [--demo true]` | Deploy + `init()` a pre-approved flash-loan receiver. `--demo true` deploys the no-initiator-check `DemoOpenMultiFlashReceiver` the public UI uses — **hard-gated to a testnet chainId allowlist** (see §6). |
| `hardhat check-registry-drift --network hadrian [--registry <path>]` | Read-only: diff `deployments/<net>.json` + live on-chain oracle sources against the registry (`apps/aave/` + `chains/contracts.json`). Exits non-zero on drift; use as a pre-publish gate. |
| `hardhat seed-pool --network hadrian` | Supply deployer-held wrapper liquidity into the pool (borrow/flash-loan funds) |
| `hardhat setup-emodes --network hadrian` | Configure E-mode categories + bind assets |
| `hardhat reset-oracle-prices --network hadrian` | Restore all reserve oracle sources to canonical mock prices (undo §5 or a demo price drop) |
| `scripts/migrate-oracle-to-ogv2-resilient.ts` | Point USDC/ETH/SOL at live-Pyth OG-V2 via a resilient shim (see §5) |
| `scripts/revert-oracle-to-mocks.ts` | Point USDC/ETH/SOL back at their mock aggregators |
| `scripts/liquidation-demo-setup.ts` | Stand up a liquidatable victim for a live liquidation demo (see §7) |

Scripts run via `npx hardhat run scripts/<name>.ts --network hadrian`.

---

## 5. Oracle — live Pyth via Oracle Gateway V2

`AaveOracle` reads a price source per asset. On Hadrian:

- **wUSDC / wETH / wSOL** → live Pyth, read through OG-V2's `PythPullAdapter`
  (the adapter clones read the on-chain Pyth **Solana** PDA — an EVM→Solana
  cross-VM read — kept ~20-30s fresh by the oracle-keeper). So every
  supply/borrow/liquidate/HF read exercises the cross-VM oracle path.
- **HEAT / SALT / MILK / OIL** → fixed `MockAggregator`s (invented demo
  tokens; no real Pyth feed exists).

**Interface gap (important):** Aave V3 reads the Chainlink-**V2**
`latestAnswer()`; OG-V2's adapter implements only Chainlink-**V3**
`latestRoundData()`. Pointing AaveOracle directly at the adapter reverts
`getAssetPrice` → the whole market breaks. A shim bridges them:

- `contracts/misc/PythPullToV2ShimResilient.sol` — forwards
  `latestRoundData().answer` as `latestAnswer()`, and on **any** revert
  (stale / paused / low-confidence) or non-positive price **falls back to the
  asset's mock aggregator** instead of propagating the revert. Net: fresh
  keeper → real Pyth; keeper lapse → last canonical mock price, never a
  market-wide revert. (`PythPullToV2Shim.sol` is the minimal non-resilient
  reference; don't wire it in production — a keeper lapse would break reads.)

Migrate: `npx hardhat run scripts/migrate-oracle-to-ogv2-resilient.ts --network hadrian`
(deploys one shim per asset, verifies each reads a sane live price *before*
`setAssetSources`, verifies AaveOracle after). Revert:
`scripts/revert-oracle-to-mocks.ts`.

Full design + risks: rome-specs
`active/technical/2026-05-27-aave-v3-ogv2-oracle-integration.md`.

---

## 6. Flash loans — the pre-approve pattern

Single-asset `flashLoanSimple` works out of the box. **Multi-asset
`Pool.flashLoan` (2+ cached wrappers) needed one Rome-specific change** —
not a protocol change, a receiver-design change.

Solana caps accounts per transaction (64 mainnet / 128 devnet). Rome's
iterative VM declares the same account union on every signature, so the cap is
effectively per-sig. Aave's canonical in-callback `IERC20.approve(POOL, …)`
adds the SPL `approve_checked` accounts (~3-4 per asset), pushing a 2-asset
flash loan past the cap → the proxy rejects it (surfaced as an empty
JSON-RPC `-32000`).

**Fix:** pre-approve the receiver to the Pool in a one-time `init()` tx (at
deploy time), so the flash-loan tx itself carries no in-callback approve. A
2-asset flash loan then lands at ~60 accounts/sig, under the cap.

Receiver contracts (`contracts/test/`):
- `PreApprovedFlashReceiverBase.sol` — abstract base with the pre-approve
  lifecycle + hardening (anti-spoof `msg.sender == POOL`, anti-grief
  `authorizedInitiator` whitelist, onlyOwner init/revoke/sweep).
- `PreApprovedMultiFlashReceiver.sol` — concrete production receiver.
- `DemoOpenMultiFlashReceiver.sol` (`0x2af94F2C104fD2DfBCFb561238b2F9B0f40eE05A`)
  — **demo-only**, no initiator whitelist so any wallet can drive the public
  demo. Testnet-only; production must use the hardened base. The
  `deploy-flash-receiver --demo` path is **mechanically gated**: it reads the
  live chainId and hard-fails unless it is in an explicit testnet allowlist
  (`DEMO_RECEIVER_TESTNET_CHAIN_IDS`), so the no-initiator receiver can never be
  shipped to a mainnet chain by a stray flag.

Smoke it: `npx hardhat gamut-extras --network hadrian`. Full design + the
empirical account breakdown: rome-specs
`active/technical/2026-05-27-multi-asset-flashloan-on-rome.md`.

---

## 7. Setting up a live liquidation demo

You can't liquidate your own position, and Aave/the demo run **no keeper bot**
— liquidation is a manual `Pool.liquidationCall`. To demo it you need a
*different* account underwater. `scripts/liquidation-demo-setup.ts` does this
with two mock tokens (so it's self-provisioning via the faucet, no real value):

1. A throwaway LP key claims + supplies MILK (borrow liquidity).
2. A throwaway victim key claims HEAT, supplies it as collateral, borrows MILK.
3. The deployer drops HEAT's **mock** price → victim's HF falls below 1.
4. The victim now appears in the `/liquidate` feed; any wallet with MILK can
   liquidate it and collect the 10% bonus.

```bash
npx hardhat run scripts/liquidation-demo-setup.ts --network hadrian
```

The script prints the victim address + HF. Restore prices afterward with
`hardhat reset-oracle-prices`. (Note: only mock-priced tokens — HEAT/SALT/
MILK/OIL — can have their price dropped this way; wUSDC/wETH/wSOL read live
Pyth and can't be moved.)

---

## 8. Verification commands

```bash
# A price reads sane through the oracle (8-dec USD):
cast call 0x8A7dcF67BBe2BacF6f9d82E14c16B76df6b9DB11 \
  "getAssetPrice(address)(uint256)" <underlying> --rpc-url https://hadrian.testnet.romeprotocol.xyz/

# Demo flash-loan receiver is callable + pre-approved:
cast call 0x2af94F2C104fD2DfBCFb561238b2F9B0f40eE05A "POOL()(address)" \
  --rpc-url https://hadrian.testnet.romeprotocol.xyz/   # → the Pool address

# A user's account health:
cast call 0x56cD6Bd0FDAd19F44df9D8b9aadD84f964c2fE11 \
  "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" \
  <user> --rpc-url https://hadrian.testnet.romeprotocol.xyz/

# Full smoke:
npx hardhat gamut-extras --network hadrian   # expect all PASS
```

---

## 9. Mainnet-readiness checklist

Hadrian is a **testnet demo**. Several deliberate testnet choices MUST change
before any mainnet promotion — none are bugs on testnet:

- **Admin is a single EOA.** The deployer (`0x1f4946Be…48F6`) is ACL admin +
  pool admin + asset-listing admin + emergency admin + `PoolAddressesProvider`
  owner + `AaveOracle` source-setter + faucet owner + mock-token minter. That
  one key can repoint any asset's price source (the liquidation lever). Mainnet:
  split roles across a multisig / timelock.
- **Treasury = deployer, reserve factor 0.** No `Collector` is deployed (slim
  cut); reserve fees would accrue to the deployer EOA. Deploy `treasury/Collector`
  + set a real treasury before reserve factor > 0. (Already a CLAUDE.md blocker.)
- **Resilient oracle shim falls back to a frozen mock.**
  `PythPullToV2ShimResilient` returns a `MockAggregator` price on any OG-V2
  revert (keeper lapse) so the market never reverts — correct for a testnet
  demo, **dangerous on a live market** (a stale / owner-settable price feeding
  liquidations). `latestAnswer()` is `view`, so it cannot emit on fallback;
  observability is the off-chain oracle-keeper staleness alert. Mainnet: don't
  use the resilient variant — wire a real second source and let
  `PriceOracleSentinel` gate liquidations on staleness.
- **Demo flash receiver has no initiator check.** `DemoOpenMultiFlashReceiver`
  is testnet/demo-only and now **mechanically gated** to a testnet chainId
  allowlist in `deploy-flash-receiver` (§6). Mainnet apps inherit
  `PreApprovedFlashReceiverBase` (initiator whitelist).
- **MockAggregator prices are frozen** for HEAT/SALT/MILK/OIL (invented demo
  tokens). Mainnet markets list only assets with a real price feed.

### Registry drift to reconcile

`check-registry-drift` (§4) surfaces real drift on Hadrian today — reconcile via
`/publish-registry-pr` before treating the registry as canonical for this app:

- `chains/200010-hadrian/contracts.json` lists the Aave core at the **05-24
  deploy** addresses (e.g. `AavePool 0x9352FB…`), but the live deploy +
  `apps/aave/200010-hadrian.json` are the **05-25 redeploy** (`Pool 0x56cD6B…`).
  The contracts.json Aave rows are stale.
- `apps/aave` records all three feeds as `mock-aggregator`, but on-chain
  USDC/ETH/SOL now read **live Pyth via resilient shims** (the OG-V2 migration,
  §5). That migration was never reflected in the registry. (Fix the oracle
  wiring via the `rome-solidity` oracle-deploy path, not by hand-editing
  `oracle.json`.)

## 10. Related

- Demo UI + user guide: [`rome-aave-v3-demo`](https://github.com/rome-protocol/rome-aave-v3-demo)
- Specs: rome-specs `active/technical/2026-05-27-multi-asset-flashloan-on-rome.md`,
  `active/technical/2026-05-27-aave-v3-ogv2-oracle-integration.md`
- Registry entry: `apps/aave/200010-hadrian.json`
