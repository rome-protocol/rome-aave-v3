# Aave V3 on Rome

How the Aave V3 deployment on Rome is built and run. The reference chain is **Hadrian** (`200010`), Rome's public testnet on a Solana devnet substrate. This page covers what runs, how it differs from Aave on Ethereum, how to deploy it, the day-2 tasks, the price oracle, and the flash-loan pattern.

The addresses below are for Hadrian. `deployments/hadrian.json` and the other `deployments/hadrian-*.json` files are the record of this market.

---

## 1. What this is

The lending protocol is **Aave V3.6**, a slim cut of [`aave-dao/aave-v3-origin`](https://github.com/aave-dao/aave-v3-origin) vendored unmodified under `contracts/`, running inside Rome's EVM. The source is main at commit 1e3d70c (February 2026, after the v3.6.0 release); `UiPoolDataProviderV3`, `IERC20DetailedBytes` and the two OpenZeppelin `IERC20` and `IERC20Detailed` copies are from the v3.6.0 tag. Each vendored file keeps its upstream licence header; `NOTICE` lists the licences. Compiler settings follow Aave's `foundry.toml`: solc 0.8.27, optimizer runs 200, `evm_version: shanghai`, `bytecodeHash: none`.

The principle is **modify the token, keep the protocol canonical.** Pool, PoolConfigurator, the aTokens, the variable debt token and the interest-rate strategy are Aave's. What is Rome-specific sits at the edges:

| Layer | What | Rome-specific? |
|---|---|---|
| Lending protocol | Aave V3.6 Pool, tokens, configurator | No, Aave's contracts |
| Reserve underlyings | `SPL_ERC20_cached` wrappers (wUSDC, wETH, wSOL, wBTC): an ERC-20 view over a real Solana SPL token | Yes, the wrappers are Rome's |
| Price oracle | `RomePriceOracle` `0x3ca9343F21661c1F854860532deeC2734bcD869B`: the pool's price oracle (`PoolAddressesProvider.getPriceOracle()`) | Yes, Rome's own contract (section 5): it reads the **PriceBook entries directly**, one contract and no per-asset shim. `AaveOracle` `0x4736549a…` is only the previous oracle, still deployed and no longer read by the pool |
| Flash-loan receivers | User-supplied; this repo ships a pre-approved one | Yes, the pre-approve pattern answers Solana's account limit (section 6) |

Settlement is Solana-fast; the contracts and the JSON-RPC surface are EVM-standard, so MetaMask, ethers, viem and the Aave SDK work as they do elsewhere.

### Live Hadrian addresses (200010)

| Contract | Address |
|---|---|
| `PoolAddressesProvider` | `0x8f40D56ffAA473120177c65FC5EE431b22353CD4` |
| `Pool` | `0x81e7e7e4cBC2b5a55C2dE1d3dFCf87C0cF867520` |
| `PoolConfigurator` | `0x1186549d0E2308579337ff064B2C5865F416d01F` |
| `ACLManager` | `0x15Ef778f6399Ae984cc2A816afE76e30bd9e14D0` |
| `DefaultReserveInterestRateStrategyV2` | `0xb0a1f16C6a4254bf41BD6c972A0ABC223ba61297` |
| `RomePriceOracle` (the pool's price oracle) | `0x3ca9343F21661c1F854860532deeC2734bcD869B` |
| `AaveOracle` (previous price oracle) | `0x4736549aB02e6c6b7083b7625464368E203287E4` |
| `AaveProtocolDataProvider` | `0x79b627B56252468FD53d6F2d7C572Ea969dCC10D` |
| `UiPoolDataProviderV3` | `0xd5C1348e15543A04e6A10303429F75d1ddeFD152` |
| `WalletBalanceProvider` | `0xaEd052bE89183064598Ee15c2995a2eaD48ba047` |
| `LiquidationDataProvider` | `0xBCE92c281746cC502c74DDaC34C98Ff55A052D2a` |

| Reserve (LTV / liquidation threshold / bonus) | Underlying wrapper | aToken | variableDebtToken |
|---|---|---|---|
| wUSDC (6 decimals, 7500 / 8000 / 10500) | `0xbce339ba4c3a8de3bb8af1c5539e6ac11da3112d` | `0x12e0E4bDb983EC3fA81ECb8EC226d6a37F7b3fA5` | `0x893500a6a3273E639A341036584d33F926519caa` |
| wETH (8 decimals, 7000 / 7500 / 10500) | `0x02aeace038269f9961c93d04dcacd6fb3adfa55f` | `0x21B5602CdDAD66008e328F10Af5eB6563B065330` | `0x4cBEAA467e687CD9d4b73ac9Ec0dfC000A605B30` |
| wSOL (9 decimals, 6500 / 7000 / 10500) | `0x39f36444fcb79b3e691544aee2a832ebef54ca9f` | `0x9d9c3bf348Bf40fd35f6F9F0C46921e7Bd7e1ED0` | `0x485b8827E17c05Aa46C2E0F34388919e73DcAa86` |
| wBTC (9 decimals, 7000 / 7500 / 10500; supply cap 50, borrow cap 20) | `0x94834153ea70219d44edfe295697ff0c204ec68c` | `0xEEc1D1335F5ca2BabEfbf98D10c2145147E42Db2` | `0x67034C739c5dD5d26AF5279B8F50B6cD87e447A4` |

The wrapper moves SPL tokens as the holder's delegate: every EOA signs `HelperProgram.approve_spl(wrapper, max, mint)` once per wrapper before its first `supply` or `repay` (probe `wrapper.isEnabled(user)`). Contracts such as the aTokens are tracked in the wrapper's escrow ledger and need nothing.

---

## 2. Prerequisites

- Node and the repo's Hardhat 3: `yarn install`.
- A funded deployer key in the Hardhat keystore as `HADRIAN_PRIVATE_KEY`: `npx hardhat keystore set HADRIAN_PRIVATE_KEY`. Never put a key on a command line.
- Network config is in `hardhat.config.ts` (`hadrian`).

All tasks run as `npx hardhat <task> --network hadrian`.

---

## 3. Deploying the protocol from scratch

Order matters: reserves depend on the core stack, and the flash-loan smoke depends on liquidity.

```bash
# 1. Core stack: PoolAddressesProvider, ACLManager, interest-rate strategy, Pool (proxy),
#    PoolConfigurator, aToken and debt-token implementations, data provider.
npx hardhat deploy --network hadrian

# 2. View helper an app needs for getReservesData / getUserReservesData.
npx hardhat deploy-ui-helpers --network hadrian

# 3. (optional) Test tokens and a faucet (HEAT / SALT / MILK / OIL).
npx hardhat deploy-faucet --network hadrian

# 4. List each reserve (asset, price source, risk parameters), one call per asset.
npx hardhat init-reserve --network hadrian --asset <underlying> --symbol <symbol> --decimals <n> --price-feed <source>

# 5. (optional) Auxiliary view helpers: WalletBalanceProvider and LiquidationDataProvider.
npx hardhat deploy-aux --network hadrian

# 6. (optional) E-mode categories.
npx hardhat setup-emodes --network hadrian

# 7. Seed borrow-side liquidity so borrows and flash loans have funds.
npx hardhat seed-pool --network hadrian
```

Every deploy task writes the resulting addresses to `deployments/<network>.json`.

---

## 4. Tasks and scripts

| Task or script | What it does |
|---|---|
| `hardhat gamut-extras --network hadrian` | Smoke test: multi-asset `flashLoan` through a pre-approved receiver, `setUserEMode`, and `repayWithATokens` |
| `hardhat deploy-flash-receiver --network hadrian [--demo true]` | Deploy and `init()` a pre-approved flash-loan receiver. `--demo true` deploys the no-initiator-check `DemoOpenMultiFlashReceiver`, which is hard-gated to a testnet chain-id allowlist (section 6) |
| `hardhat seed-pool --network hadrian` | Supply deployer-held wrapper liquidity into the pool |
| `hardhat setup-emodes --network hadrian` | Configure E-mode categories and bind assets |
| `hardhat reset-oracle-prices --network hadrian` | Restore mock-priced reserves to their canonical mock prices. It edits `AaveOracle` only, so it has no effect on the pool while `RomePriceOracle` is the pool's oracle |
| `scripts/switch-price-oracle.ts` | Point the pool at the oracle in `deployments/hadrian-rome-price-oracle.json` with `PoolAddressesProvider.setPriceOracle` (owner only); `PRICE_ORACLE=previous` points it back |
| `scripts/switch-oracle-to-book.ts` | Point the listed reserves of `AaveOracle` at the shims in one `setAssetSources` call (`ORACLE_SHIMS=lean` or `book`) |
| `scripts/revert-oracle-to-constants.ts` | Point the listed reserves of `AaveOracle` back at their constant aggregators |
| `scripts/measure-price-cost.ts` | Read-only: `eth_estimateGas` and the Solana account count for borrow, withdraw and `liquidationCall` |
| `scripts/measure-rome-price-oracle.ts` | Read-only: account counts for `AaveOracle` against a direct PriceBook read, and a real borrow if you pass a user |
| `scripts/set-reserve-caps.ts` | Supply and borrow cap (whole tokens) for one reserve through `PoolConfigurator`; `DRY_RUN=1` previews with `eth_call` and `eth_estimateGas` |
| `scripts/wbtc-admin.ts` | Pool-admin calls for the wBTC reserve (borrow off, LTV zero, drop, withdraw all), signed by the keystore key; `DRY_RUN=1` previews |
| `scripts/wbtc-four-collateral-measure.ts` | Read-only: account counts for borrow, withdraw-with-debt and `liquidationCall` of a user holding all four assets as collateral, against the proxy's account ceiling |

Scripts run as `npx hardhat run scripts/<name>.ts --network hadrian`. The unit tests run the same way: `npx hardhat run test/rome-price-oracle.test.ts` (likewise `test/price-book-entry-shim.test.ts` and `test/book-shim-resilient.test.ts`).

---

## 5. Oracle: reading the PriceBook directly

Rome's live prices are the **PriceBook** (`0xac3d80043ead56fcf94db4574a69ee0975f7a63f`): one entry per source account, refreshed by a keeper, each entry carrying an answer, a publish time and a status. The USDC, ETH, SOL and BTC entries are what Aave reads.

`AaveOracle` reads one Chainlink-V2 `latestAnswer()` source per asset. A Solana transaction carries a limited number of accounts (Rome's SDK allows 63), and every contract a price read touches adds accounts. Reading a price through `AaveOracle`, a per-asset shim and the PriceBook's feed adapter was too many for a borrow against several collateral assets, so the oracle was reduced in steps:

1. `contracts/misc/BookFeedToV2ShimResilient.sol` wraps a PriceBook feed adapter as a V2 source, with a fixed fallback price when the adapter reverts or answers zero or less.
2. `contracts/misc/PriceBookEntryShim.sol` drops the adapter: it calls `PriceBook.entryOf(sourceAccount)` once and keeps the entry key, `maxStaleness` and the fallback price in immutable bytecode.
3. `contracts/misc/RomePriceOracle.sol` drops `AaveOracle` as well. The pool asks `PoolAddressesProvider.getPriceOracle()` for this one contract, which reads each asset's PriceBook entry directly and holds the asset table and the PriceBook address as immutables. No storage read, no per-asset contract. It has four slots: wUSDC, wETH, wSOL, wBTC.

`RomePriceOracle` implements what the vendored v3.6 code calls on the oracle: `getAssetPrice`, `BASE_CURRENCY` (0, USD) and `BASE_CURRENCY_UNIT` (1e8), `getAssetsPrices`, `getSourceOfAsset` (the oracle itself for its four assets, zero otherwise) and `getFallbackOracle` (zero). The setters are not implemented: the table is fixed, and a change is a new oracle plus `setPriceOracle`.

**Fallback rule.** An entry is valid when its status is live (1), `answer > 0`, `publishTime` is not in the future, and `now - publishTime <= maxStaleness` (3600 s). Any other state (never written, paused, stale, non-positive, or an unreachable book) returns the fixed fallback price stored in the contract, not a revert, so a stalled book never breaks `getReservesData` or `getUserAccountData`. The fallback is the live price read at deploy time, so a stalled book freezes the price at that value. An unknown asset reverts, as `AaveOracle` does on Hadrian (it has no fallback oracle). The PriceBook itself refuses to write a price whose confidence interval is too wide, so the oracle needs no extra read for that.

**Account counts.** Measured read-only on Hadrian on 2026-11-05 with `rome_emulateCallAccounts`: one price read through `AaveOracle` touches 11 accounts and a direct `entryOf` read 8. `RomePriceOracle` adds only its own contract account to the direct read. `scripts/measure-rome-price-oracle.ts` repeats the measurement, and `scripts/measure-price-cost.ts` measures a real borrow, withdraw or liquidation. Take compute units from the receipts of real sends: `eth_estimateGas` is Rome gas, not Solana compute units.

The records of what is deployed are `deployments/hadrian-rome-price-oracle.json` (the oracle, the PriceBook, and each asset's entry key, `maxStaleness` and fallback price), `deployments/hadrian-oracle-lean-shims.json` and `deployments/hadrian-oracle-shims.json`. The oracle deploy scripts read their inputs from Rome's chain registry and are not part of this repository; the records hold the values they wrote. `hadrian-oracle-shims.json` holds the `BookFeedToV2ShimResilient` shims (a feed adapter over the PriceBook, 3600 s, with a constant-aggregator fallback), and `hadrian-oracle-lean-shims.json` holds the `PriceBookEntryShim` shims that `AaveOracle` reads.

---

## 6. Flash loans: the pre-approve pattern

Single-asset `flashLoanSimple` works as on Ethereum. Multi-asset `Pool.flashLoan` with two or more cached wrappers needs one Rome-specific change, in the receiver, not in the protocol.

Solana caps the accounts a transaction carries, and Rome's iterative VM declares the same account union on every signature. Aave's canonical in-callback `IERC20.approve(POOL, ...)` adds the SPL `approve_checked` accounts for each asset (about 3-4 each), which pushes a two-asset flash loan past the cap, and the proxy rejects it.

The fix is to approve the Pool once, in a separate `init()` transaction at deploy time, so the flash-loan transaction carries no in-callback approve. A two-asset flash loan then lands at about 60 accounts per signature.

Receivers (`contracts/test/`):

- `PreApprovedFlashReceiverBase.sol`: abstract base with the pre-approve lifecycle and its hardening (`msg.sender == POOL`, an `authorizedInitiator` whitelist, owner-only `init`, `revoke` and `sweep`).
- `PreApprovedMultiFlashReceiver.sol`: the concrete receiver.
- `DemoOpenMultiFlashReceiver.sol`: demo only. It has no initiator whitelist, so any wallet can drive a public demo. `deploy-flash-receiver --demo` reads the live chain id and fails unless it is in the testnet allowlist (`DEMO_RECEIVER_TESTNET_CHAIN_IDS`), so this receiver cannot be deployed to a mainnet chain by a stray flag.

Smoke test: `npx hardhat gamut-extras --network hadrian`.

---

## 7. Verification commands

```bash
# A price through the pool's oracle (8-decimal USD):
cast call 0x3ca9343F21661c1F854860532deeC2734bcD869B \
  "getAssetPrice(address)(uint256)" <underlying> --rpc-url https://hadrian.testnet.romeprotocol.xyz/

# A user's account health:
cast call 0x81e7e7e4cBC2b5a55C2dE1d3dFCf87C0cF867520 \
  "getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)" \
  <user> --rpc-url https://hadrian.testnet.romeprotocol.xyz/

# Smoke test:
npx hardhat gamut-extras --network hadrian
```

---

## 8. Before a mainnet market

Hadrian is a testnet, and a few testnet choices change before a market with real funds:

- **Admin is a single EOA.** The deployer is ACL admin, pool admin, asset-listing admin, emergency admin and owner of `PoolAddressesProvider`, and it can point the pool at another oracle. A live market splits these roles across a multisig and a timelock.
- **Treasury is the deployer and the reserve factor is 0.** The slim cut ships no `Collector`. Deploy `treasury/Collector` and set a real treasury before the reserve factor goes above 0.
- **The oracle falls back to a fixed price.** `RomePriceOracle` and the shims answer a fixed price when the book stalls, which keeps a testnet market answering and is wrong for a market with real liquidations: a stale price would feed them. A live market wires a real second source and lets `PriceOracleSentinel` gate liquidations on staleness.
- **The demo flash receiver has no initiator check.** It is gated to testnet chain ids in `deploy-flash-receiver`. A live market inherits `PreApprovedFlashReceiverBase`.

---

## 9. Related

- Demo app and user guide: [`rome-aave-v3-demo`](https://github.com/rome-protocol/rome-aave-v3-demo)
- Rome documentation: [docs.rome.builders](https://docs.rome.builders)
