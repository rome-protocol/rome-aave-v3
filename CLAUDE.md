# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Canonical Aave V3 (slim first-cut) deployed on **Rome Protocol** — an EVM-compatible layer on Solana. Vendored byte-identical source from `@aave-dao/aave-v3-origin@3.6.0` plus Rome-specific deployment scaffolding.

**Architectural principle**: modify the token (`SPL_ERC20_cached`, lives in `rome-solidity`), keep the lending protocol canonical. Same pattern as `rome-uniswap-v3` and `compound-on-rome-comet`.

**Full living docs**: [`docs/AAVE-V3-ON-ROME.md`](docs/AAVE-V3-ON-ROME.md) — what runs, oracle (OG-V2 shim), flash-loan pre-approve pattern, live Hadrian addresses. End-user guide for the demo UI: [`rome-aave-v3-demo/docs/USER-GUIDE.md`](https://github.com/rome-protocol/rome-aave-v3-demo/blob/main/docs/USER-GUIDE.md).

## Scope (slim + view helpers)

Vendored: the supply / borrow / repay / withdraw / liquidation surface + view-helpers + base classes for user-side receivers. ~95 contracts.

- **Pool**: `Pool`, `PoolInstance`, `PoolStorage`, `PoolConfigurator`, `PoolConfiguratorInstance`, `PoolAddressesProvider`, `ACLManager`
- **Tokenization**: `AToken`, `VariableDebtToken`, plus `*Instance` clones + base classes (`IncentivizedERC20`, `ScaledBalanceTokenBase`, `DebtTokenBase`, etc.) — minus delegation flavors
- **Libraries**: all of `protocol/libraries/{logic,math,types,configuration,helpers}` (SupplyLogic, BorrowLogic, LiquidationLogic, ValidationLogic, PoolLogic, ReserveLogic, etc.)
- **Oracle**: `AaveOracle` + `mocks/oracle/CLAggregators/MockAggregator` for testnet price feeds + `PriceOracleSentinel` (vendored, not yet deployed — needs Rome-specific sentinel design before wiring to PoolAddressesProvider)
- **IRS**: `DefaultReserveInterestRateStrategyV2` (V3.6 single-pool-wide design — set via Pool constructor)
- **Helpers**: `AaveProtocolDataProvider` (view aggregator) + `UiPoolDataProviderV3` (single-call aggregator for UIs) + `WalletBalanceProvider` (batch ERC-20 + native balance reads) + `LiquidationDataProvider` (liquidator view helper)
- **Flash-loan base classes**: `FlashLoanSimpleReceiverBase` + `FlashLoanReceiverBase` (abstract; downstream user contracts inherit these)
- **Upgradeability**: `VersionedInitializable`, `InitializableImmutableAdminUpgradeabilityProxy`

Excluded (re-add if needed):
- `extensions/stata-token/*` — ERC-4626 yield-bearing aToken wrappers. Add when a Rome ERC-4626 consumer (Morpho/Yearn-style) needs integration.
- `extensions/v3-config-engine/*` — Aave Governance batch-config helper. Only relevant under DAO admin.
- `protocol/tokenization/delegation/*` — GHO governance delegation (`ATokenWithDelegation`, `IATokenWithDelegation`, `IDelegationToken`). Not relevant without GHO on Rome.
- `helpers/L2Encoder` — calldata compression for L2s; Rome-incompatible (iterative VM is the equivalent here).
- `helpers/WrappedTokenGatewayV3` — native-gas-as-collateral wrapper; no native-RSOL Aave market planned.
- `helpers/UiIncentiveDataProviderV3` — depends on RewardsController, not yet vendored.
- `instances/L2Pool`, `instances/VariableDebtTokenMainnetInstanceGHO`, `instances/ATokenWithDelegationInstance` — L2- or GHO-specific.
- `mocks/*` — except `MockAggregator`. Test contracts live under `contracts/test/` instead.
- `rewards/*` — incentives module (1843 LoC). Add when a Rome incentive program is designed (reward token + emission schedule).
- `treasury/*` — `Collector` + interface (555 LoC + OZ-upgradeable dep). **Mainnet-blocker** — needed once reserve factor > 0. Slim cut currently leaves reserve factor at 0; revenue accrues nowhere meaningful.

## Configuration / chain metadata

Chain ids, RPC URLs, gas-token mints, cached wrapper addresses, etc. for every Rome chain are canonical at **[`rome-protocol/rome-registry`](https://github.com/rome-protocol/rome-registry)**. Don't hardcode them in `hardhat.config.ts`, the deploy task, or `deployments/*.json` patches.

After a successful deploy, update the registry's `chains/<id-slug>/contracts.json` for the affected chain with the new Aave V3 contracts.

## Package manager

**Yarn-only** — `yarn.lock` is checked in; no `package-lock.json`. Always install with `yarn install --frozen-lockfile`. Same rationale as `rome-uniswap-v2/v3`: Hardhat 3 + ESM doesn't tolerate the stale ts-node tree that `npm install` brings in.

## The `openzeppelin-contracts` symlink trick

Aave V3 source imports OZ as `openzeppelin-contracts/contracts/...` (foundry-style remapping). The `@openzeppelin/contracts` npm package layout drops the `contracts/` subdirectory in v5+, so naive resolution fails (`node_modules/openzeppelin-contracts/contracts/...` doesn't exist).

Fix: a `postinstall` script in `package.json` creates `node_modules/openzeppelin-contracts/contracts -> .` symlink. Hardhat now resolves `openzeppelin-contracts/contracts/utils/math/SafeCast.sol` → `node_modules/openzeppelin-contracts/utils/math/SafeCast.sol`. Same source, just a path-shape adapter.

Don't remove this — every fresh `yarn install` recreates `node_modules/`, and the postinstall hook restores the symlink.

## Build & Deploy Commands

```shell
# Install deps (symlink trick handled by postinstall)
yarn install --frozen-lockfile

# Keystore setup per chain
npx hardhat keystore set --dev <CHAIN>_PRIVATE_KEY

# Compile (88 files; expect 1 upstream SPDX warning on WETH9)
<CHAIN>_PRIVATE_KEY=<key> npx hardhat compile

# Deploy the Aave stack (writes deployments/<network>.json)
npx hardhat deploy --network <chain>

# Add a reserve (asset listing) — repeat per asset
npx hardhat init-reserve --network <chain> \
  --asset 0x33fb7AD189B0A59CCAFcC3337F3a8B61e3719912 \
  --symbol wUSDC --decimals 6 --price-usd 1.0 \
  --ltv 7500 --liquidation-threshold 8000

npx hardhat init-reserve --network <chain> \
  --asset 0x09A9B33501f2cf1E42dF14c6EcE1F7EDE8376366 \
  --symbol wETH --decimals 8 --price-usd 3000.0 \
  --ltv 7000 --liquidation-threshold 7500

# Smoke gamut: supply/borrow/repay/withdraw
npx hardhat gamut --network <chain> \
  --collateral-symbol wUSDC --borrow-symbol wETH \
  --collateral-amount 10000 --lend-amount 10000 --borrow-amount 500
```

## Available networks

| Network | chainId | Env | RPC |
|---|---|---|---|
| `aurelius` | 30001 | real-testnet (Solana testnet) | `aurelius.real-testnet.romeprotocol.xyz` |
| `augustus` | 200001 | testnet (Solana devnet) | `augustus.testnet.romeprotocol.xyz` |
| `marcus` | 121301 | devnet (Solana devnet) | `marcus.devnet.romeprotocol.xyz` |
| `hadrian` | 200010 | testnet (Solana devnet) — first target | `hadrian.testnet.romeprotocol.xyz` |

New chains: duplicate one entry in `hardhat.config.ts` + set `<CHAIN>_PRIVATE_KEY` in the keystore.

## Deployment procedure (new chain bring-up)

1. **Look up the chain's cached wrappers** in the registry (`chains/<id-slug>/contracts.json` → wUSDC `SPL_ERC20_cached`, wETH `SPL_ERC20_cached`, etc.)
2. **Add network entry** to `hardhat.config.ts` if missing
3. **Set keystore key**: `npx hardhat keystore set --dev <CHAIN>_PRIVATE_KEY`
4. **Compile**: `<CHAIN>_PRIVATE_KEY=<key> npx hardhat compile`
5. **Deploy stack**: `npx hardhat deploy --network <chain>` — writes the per-network artifact
6. **Init reserves** — one `init-reserve` call per asset. Picks a USD price for the MockAggregator (stablecoins: 1.0; volatile assets: a reasonable estimate)
7. **Run smoke gamut**: `npx hardhat gamut --network <chain> --collateral-symbol <S1> --borrow-symbol <S2>`
8. **Update the registry**: open a PR adding the Aave V3 contracts under `chains/<chainId>-<slug>/contracts.json`

## Solidity Compiler Version

Single version: `=0.8.27` — matches Aave V3.6 `foundry.toml`. Settings:
- `optimizer.runs = 200`
- `evmVersion = 'shanghai'`
- `metadata.bytecodeHash = 'none'` (deterministic bytecode across local recompiles)

Don't change without re-running the gamut on Hadrian and verifying all 88 contracts still compile.

## Architecture (the Rome bits)

**Rome-specific**: nothing in this repo. The cached wrapper (`SPL_ERC20_cached`) lives in `rome-solidity`. Aave V3 composes with it natively except for one operational step:

### ATA warmup (same gotcha as rome-uniswap-v3)

When `Pool.supply(asset, amount, ...)` lands the underlying tokens at the `aToken` address, Pool also reads `IERC20(asset).balanceOf(aToken)` in liquidity-index updates + flashloan accounting. The cached `SPL_ERC20_cached` wrapper reverts on `balanceOf` if the aToken's SPL associated-token-account hasn't been initialized.

Solution: `tasks/init-reserve.ts` calls `wrapper.ensure_token_account(aToken)` once per (aToken, cached-wrapper) pair after `initReserves`. Auto-detected via the `0x5e094743` selector probe; plain ERC20s are skipped.

### Cached wrapper composition

Aave's `IERC20(asset).transferFrom(user, aToken, amount)` in supply → cached wrapper's `transferFrom` → `SplCached.transferFrom` (cached track). Same for `transfer` in withdraw / liquidation. All cache-track-clean per `SPL_ERC20_cached` shipped in `rome-solidity#210`. No `verify_call` clash; no track conflicts.

### Single SPL delegate slot — same UX constraint

SPL Token has one delegate slot per ATA (per Aave V3 spec `2026-05-23-canonical-uniswap-v3-on-rome.md`). User cannot have a pending allowance to both Aave Pool AND Uniswap V3 SwapRouter simultaneously on the same cached wrapper; the second approve overwrites the first. UI implication: re-approve Pool on context switch.

### Multi-asset Flash Loan Pattern (Rome-specific)

Canonical Aave V3 flash loan receivers call `IERC20(asset).approve(POOL, amount + premium)` **inside** `executeOperation()`. On Rome that in-callback approve adds the SPL `approve_checked` CPI's accounts (~7-10 unique) to the flash loan tx's per-sig account set. For multi-asset `Pool.flashLoan` with 2+ cached SPL wrappers, that overflow pushes per-sig past Solana's runtime `account_locks` cap (64 on mainnet, 128 on devnet/testnet). Empirical breakpoint: 2 cached wrappers tip the per-sig count from ~60 (works) to ~67+ (fails with `RomeEvmError::TooManyAccounts` → JSON-RPC -32000 from the Proxy).

**Solution: pre-approve in a separate setup tx.** Use `PreApprovedFlashReceiverBase` (`contracts/test/PreApprovedFlashReceiverBase.sol`) as the canonical base for any Rome flash loan receiver that takes 2+ cached SPL wrappers. The owner calls `init(assets)` once to set Pool's allowance to MaxUint256 on each wrapper. Subsequent `Pool.flashLoan` calls have no in-callback approve, dropping the per-sig set to ~60 — comfortably under the cap.

The base contract bakes in hardening:
- `executeOperation` rejects callbacks where `msg.sender != POOL` (anti-spoof)
- `executeOperation` rejects `initiator` addresses not in the whitelist (anti-grief — anyone can call `Pool.flashLoan` against your receiver; only whitelisted initiators reach app logic)
- `init` / `revoke` / `setInitiator` / `sweep` / `transferOwnership` are `onlyOwner`
- Decommission path: `revoke(assets)` zeroes allowances, then `sweep(asset, to, amount)` recovers stuck tokens

App-specific logic lives in `_executeOperation` (internal virtual). The concrete `PreApprovedMultiFlashReceiver` is a no-op smoke impl used by `gamut-extras` Phase A. Real apps inherit the base and put arb / refinance / swap logic in `_executeOperation`.

Deploy on a new chain via `hardhat deploy-flash-receiver --network <chain>` — that task deploys + warms ATAs on every cached wrapper + calls `init()` for every reserve in `deployments/<network>.json#_reserves`. Idempotent.

**Mainnet readiness for this pattern:** the same architectural argument holds (mainnet 64 cap is tighter, so pre-approve is MORE necessary). Per-app receiver deployment is the standard production pattern. The `PreApprovedFlashReceiverBase` is `contracts/test/` because it's a Rome operational helper (not protocol-canonical) but the security hardening is production-grade — apps should inherit it directly, not write their own from scratch.

**Demo variant — `DemoOpenMultiFlashReceiver`** (`contracts/test/`): a separate contract with NO initiator check, deployed alongside the production receiver for the rome-aave-v3-demo's public `/flashloan` UI. Any visitor connecting any wallet can trigger a Pool.flashLoan against it. Documented as DEMO-ONLY — the trade-off is convenience (no whitelisting friction) for griefing exposure (anyone could race to burn the receiver's premium funding between the demo's funding step and the flashLoan call). Production deployments should NOT use this variant. Deploy via `hardhat deploy-flash-receiver --demo true`.

## Cross-repo dependencies

| Layer | Consumer (when wired) | Method / Event |
|---|---|---|
| `Pool` | lending flow | `supply`, `borrow`, `repay`, `withdraw`, `setUserUseReserveAsCollateral`, `liquidationCall` |
| `AaveProtocolDataProvider` | quote / dashboards | `getUserReserveData(asset, user)`, `getReserveData(asset)` |
| `AaveOracle` | price preview | `getAssetPrice(asset)`, `getAssetsPrices(assets)` |
| `SPL_ERC20_cached` | every cached-wrapper holder | `ensure_token_account(aToken)` — called by `init-reserve` automatically |

When wiring a UI or consumer, use the addresses from `deployments/<chain>.json`. The canonical mirror in the registry is `chains/<chainId>-<slug>/contracts.json`.

## Tasks

| Task | Purpose |
|---|---|
| `hardhat deploy` | Bring up the full Aave stack: PoolAddressesProvider + ACLManager + IRS + Pool + PoolConfigurator + AToken/VToken impls + AaveOracle + DataProvider. Writes `deployments/<network>.json`. |
| `hardhat init-reserve` | Wire a single asset: deploy MockAggregator at given USD price → set as oracle source → `initReserves` → enable borrowing → set collateral params → warm ATA on cached wrappers. Idempotent. |
| `hardhat gamut` | Smoke test: 7-phase supply/borrow/repay/withdraw cycle with per-action Solana metrics (iter sigs, CU, max heap, slot span, wall-clock). |
| `hardhat gamut-extras` | Self-contained smoke for the three Pool methods `gamut` doesn't cover: `flashLoan` multi-asset (via the pre-approved receiver), `setUserEMode`, `repayWithATokens`. ~3 min. |
| `hardhat seed-pool` | Supply deployer-held wrapper liquidity into the pool (default 80% of every reserve balance). Unblocks demo borrow flow on a freshly-deployed chain. |
| `hardhat deploy-flash-receiver` | Deploy + init the `PreApprovedMultiFlashReceiver`. Idempotent — re-runs verify allowances and re-init any that aren't at MaxUint256. |
| `hardhat setup-emodes` | Configure two demo e-mode categories (Stablecoin + Crypto). |
| `hardhat deploy-aux` | Deploy `WalletBalanceProvider` + `LiquidationDataProvider` view helpers + register in deployments file. Idempotent. |
| `hardhat reset-oracle-prices` | Restore oracle sources to canonical mock prices (used after gamut Phase 8 cranks prices). |

## Test selection

| What changed | Run |
|---|---|
| Vendored contract (any .sol under `contracts/protocol/`, `contracts/tokenization/`, etc.) | `npx hardhat compile` + redeploy the stack + run the smoke gamut |
| Deploy task | `npx hardhat deploy --network hadrian` + `init-reserve ×2` + `hardhat gamut` |
| init-reserve task | `hardhat init-reserve` on Hadrian + verify aToken/vToken via `pool.getReserveData` |
| Network entry added | `npx hardhat compile` then dry-run deploy |

No standalone unit-test suite. Canonical Aave V3 tests live upstream at `@aave-dao/aave-v3-origin`; we don't re-run them. The stress gamut is the smoke test.

## Hadrian reference deployment

First deploy: **2026-05-25** from `fc4067e`. Deployer `0x1f4946Be340F06c46A50E65084790968aBcc48F6` (cold-wallet).

| Contract | Address |
|---|---|
| `Pool` (proxy) | `0x56cD6Bd0FDAd19F44df9D8b9aadD84f964c2fE11` |
| `Pool` (impl) | `0x8E236Bc7A2090b4383EE5D6522b9FC1843EDAFA8` |
| `PoolAddressesProvider` | `0xDba99FC11d7383e722F6DEc181F71560b2780f14` |
| `PoolConfigurator` (proxy) | `0x0C87be51a3676B5B5d9929C99B3F8496ecBB8B03` |
| `PoolConfigurator` (impl) | `0x2BF8686d3D8183014d4568dA5f10866E11e0C9A1` |
| `ACLManager` | `0x5E0FDb82A68f3705e93C5384Ccb8ac3e6841bD55` |
| `AaveOracle` | `0x8A7dcF67BBe2BacF6f9d82E14c16B76df6b9DB11` |
| `AaveProtocolDataProvider` | `0xE58Ea21dBF3f117cC8e39895E9Dcb843A31441d4` |
| `DefaultReserveInterestRateStrategyV2` | `0x626b74FF85e629555Ed9F6f595a49f1156E68ffd` |
| `ATokenImpl` | `0x47b2aB5753A1371e7186d10345Db073301cD9f18` |
| `VariableDebtTokenImpl` | `0x0e423827fE8Cd752a5A805D89d29F3F451306cF3` |
| `UiPoolDataProviderV3` | `0x62c3264DBD6c09F98719B83B38fe0084F6dDf907` |
| `WalletBalanceProvider` | `0x6B40A0cFC0ebd164834C5805C7754746359C7Fd9` |
| `LiquidationDataProvider` | `0x7d50C8EF7a6aCe3a2c44c7594100BA7D0b292f56` |
| `PreApprovedMultiFlashReceiver` | `0x263470BE61b18C919bEFE7e1b4bB752BE81bc3AC` (init'd for wUSDC + wETH + wSOL) |
| `DemoOpenMultiFlashReceiver` | `0x2af94F2C104fD2DfBCFb561238b2F9B0f40eE05A` (init'd for wUSDC + wETH + wSOL) — **DEMO ONLY**, no initiator check |

**IRS** (pool-wide): optimalUsageRatio=8000, baseVariableBorrowRate=0, slope1=400, slope2=7500.

**Listed reserves:**

| Symbol | Underlying | aToken | varDebt | MockAggregator | Price | LTV / Liq / Bonus | Decimals |
|---|---|---|---|---|---|---|---|
| wUSDC | `0x9a8B4cB73…0` | `0x16478e47F…b` | `0x0F583d7E0…2` | `0xFA71C835C…C` | $1 | 7500 / 8000 / 10500 | 6 |
| wETH | `0x55e4502D7…3` | `0x03e07E78B…C` | `0x706ab0384…4` | `0x22B046262…8` | $3000 | 7500 / 8000 / 10500 | 8 |
| wSOL | `0x8c965F79b…C` | `0x671133B02…1` | `0xA75eA3969…c` | `0x9A51b2ba5…1` | $200 | 6500 / 7000 / 11000 | 9 |

Notes:
- **wETH is 8 decimals** on Hadrian (Wormhole-bridged ETH on Solana is 8-decimal). UIs consuming this deployment must read `reserve.decimals` from the registry — never assume 18 for ETH.
- **wSOL collat parameters are tighter** than wUSDC/wETH (LTV 65 / liq threshold 70 / bonus 10%) — wSOL volatility against the USDC base is higher; tunable later via `PoolConfigurator`.
- **MockAggregator prices are frozen at deploy time.** Mainnet promotion swaps these for `pyth-pull` adapters via `AaveOracle.setAssetSources`.
- **Treasury / Collector is not deployed** in this slim cut — reserve factor accrues to a placeholder. Add the `treasury/*` module before mainnet promotion.

Post-deploy gamut (24/24 PASS, 2026-05-25):

| Action | Sigs | Sol CU | Heap |
|---|---:|---:|---:|
| `Pool.supply` | 1 | ~1.17M | ~200K |
| `Pool.borrow` | 28–30 | ~7.0M | ~124K |
| `Pool.repay` | 1 | 1.27M | 208K |
| `Pool.withdraw` | 1 | 1.23M | 218K |
| `Pool.setUserUseReserveAsCollateral` | 2 | ~640K | ~141K |
| **`Pool.liquidationCall`** | **39** | **10.21M** | 136K |
| `Pool.flashLoanSimple` | 23 | 4.68M | 104K |

All actions within Solana's 1.4M-CU per-sig + 256K-heap limits. liquidationCall is the heaviest single op at 10.21M total CU across 39 iter sigs. Same shape as Marcus (38-sig liquidation, 22-sig flashLoan).

The full deploy artifact is `deployments/hadrian.json`. Registry mirror: `chains/200010-hadrian/contracts.json`.
