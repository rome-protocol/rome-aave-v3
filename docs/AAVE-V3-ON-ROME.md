# Aave V3 on Rome

Living documentation for the Aave V3 deployment on Rome (reference chain:
**Hadrian**, `200010`, Rome testnet on Solana devnet substrate). Covers what
runs, how it differs from mainnet Aave, how to deploy it, and the operational
tasks. End-user instructions for the demo UI live in
[`rome-aave-v3-demo/docs/USER-GUIDE.md`](https://github.com/rome-protocol/rome-aave-v3-demo/blob/main/docs/USER-GUIDE.md).

> Addresses below are point-in-time for Hadrian; `deployments/<chain>.json`
> and the public registry ([`rome-registry`](https://github.com/rome-protocol/rome-registry),
> `apps/aave/<chainId>-<slug>.json`) are authoritative.

---

## 1. What this is — Aave V3, canonically, on Rome EVM

This is **canonical Aave V3.6**, byte-identical to the upstream
`@aave-dao/aave-v3-origin@3.6.0` source (slim cut), running unmodified inside
Rome's EVM. Same `Pool`, `PoolConfigurator`, `AaveOracle`, aTokens, variable
debt tokens, interest-rate strategy. Compiler matches Aave's foundry.toml:
solc 0.8.27, optimizer runs 200, `evm_version: shanghai`, `bytecodeHash: none`.

The design principle (shared with compound-on-rome-comet): **modify
the token, keep the protocol canonical.** Aave's contracts are untouched; the
only Rome-specific pieces sit at the edges:

| Layer | What | Rome-specific? |
|---|---|---|
| Lending protocol | Aave V3.6 Pool + tokens + configurator | **No** — byte-identical mainnet source |
| Reserve underlyings | `SPL_ERC20_cached` wrappers (wUSDC/wETH/wSOL) + optional mock ERC-20s (HEAT/SALT/MILK/OIL; none on the current Hadrian market) | The wrappers are Rome (ERC-20 view over a real Solana SPL token) |
| Price oracle | `AaveOracle` reading per-asset sources | Real assets read the **PriceBook `*/USD-BOOK` feeds through resilient shims** (see §5); mock tokens use fixed `MockAggregator`s |
| Flash-loan receivers | user-supplied; demo ships a pre-approved one | Pre-approve pattern is Rome's answer to Solana's account cap (see §6) |

Settlement is Solana-fast; the contracts and JSON-RPC surface are
EVM-canonical, so MetaMask + ethers/viem + the Aave SDK all work as-is.

### Live Hadrian addresses (200010)

Market redeployed 2026-09-19 on the ERC20SPLFactory 9.0.0 wrappers (the previous
market's reserves sat on older wrappers, whose every write now reverts
`DELEGATECALL/CALLCODE into a precompile that signs as the caller is prohibited`;
that market — Pool `0x54701445…` — is retired in place, not drained).

| Contract | Address |
|---|---|
| `PoolAddressesProvider` | `0x8f40D56ffAA473120177c65FC5EE431b22353CD4` |
| `Pool` | `0x81e7e7e4cBC2b5a55C2dE1d3dFCf87C0cF867520` |
| `PoolConfigurator` | `0x1186549d0E2308579337ff064B2C5865F416d01F` |
| `ACLManager` | `0x15Ef778f6399Ae984cc2A816afE76e30bd9e14D0` |
| `DefaultReserveInterestRateStrategyV2` | `0xb0a1f16C6a4254bf41BD6c972A0ABC223ba61297` |
| `AaveOracle` | `0x4736549aB02e6c6b7083b7625464368E203287E4` |
| `AaveProtocolDataProvider` | `0x79b627B56252468FD53d6F2d7C572Ea969dCC10D` |
| `UiPoolDataProviderV3` | `0xd5C1348e15543A04e6A10303429F75d1ddeFD152` |
| `WalletBalanceProvider` | `0xaEd052bE89183064598Ee15c2995a2eaD48ba047` |
| `LiquidationDataProvider` | `0xBCE92c281746cC502c74DDaC34C98Ff55A052D2a` |

| Reserve | Underlying (registry wrapper) | aToken | variableDebtToken | Fixed aggregator (revert target) |
|---|---|---|---|---|
| wUSDC (6d, 7500/8000/10500) | `0xbce339ba4c3a8de3bb8af1c5539e6ac11da3112d` | `0x12e0E4bDb983EC3fA81ECb8EC226d6a37F7b3fA5` | `0x893500a6a3273E639A341036584d33F926519caa` | `0xD983a0026022a914896870d31C42bbE011DEa57b` ($1) |
| wETH (8d, 7000/7500/10500) | `0x02aeace038269f9961c93d04dcacd6fb3adfa55f` | `0x21B5602CdDAD66008e328F10Af5eB6563B065330` | `0x4cBEAA467e687CD9d4b73ac9Ec0dfC000A605B30` | `0x7465eEd581FBc7068F76e4A76E135ac4027f4c8D` ($3000) |
| wSOL (9d, 6500/7000/10500) | `0x39f36444fcb79b3e691544aee2a832ebef54ca9f` | `0x9d9c3bf348Bf40fd35f6F9F0C46921e7Bd7e1ED0` | `0x485b8827E17c05Aa46C2E0F34388919e73DcAa86` | `0x0a1a56F815568Dc5883f7205BFf94522112106A5` ($200) |

The live price source of each reserve is its BOOK shim, not the fixed aggregator above. The fixed
aggregators in the table are only the switch-back target of `scripts/revert-oracle-to-constants.ts`;
they are not the shims' fallback (each shim's `fallbackSource()` is a different fixed aggregator,
see §5). BOOK shims: wUSDC `0x77b79B65105df5caE7D296f074989cFd721E9e79` (fallback
`0x9165A273F6be477Ef110793b0C64383cE9FD81C0`), wETH `0xc0767d12B73B55855D893E4e5456C602550b253f`
(fallback `0x66D94D25ECdCbA90eD005A23D67D2FdAc3d4412A`), wSOL `0x72Dc30C129Ec17e3a1Dd5B5541efb00516fD70A0`
(fallback `0x0E7B06BdA8AC5da68684BDfdADf49539a02ecae0`).

`deployments/hadrian.json` (addresses only, committed) is this market's record; the tasks and
scripts read it, and `deployments/hadrian-oracle-shims.json` holds the BOOK shims (§5).

The 9.0.0 wrapper moves SPL as the holder's delegate: every EOA must sign
`HelperProgram.approve_spl(wrapper, max, mint)` once per wrapper before its
first `supply`/`repay` (probe `wrapper.isEnabled(user)`); contracts such as the
aTokens are tracked in the wrapper's escrow ledger and need nothing. There are
no mock collateral tokens on this market.

---

## 2. Prerequisites

- Node + the repo's hardhat (Hardhat 3). `yarn install --frozen-lockfile`.
- A funded deployer key in the hardhat keystore as `HADRIAN_PRIVATE_KEY` (the
  Hadrian deployer = pool admin = `0x1f4946Be340F06c46A50E65084790968aBcc48F6`).
  The keystore is per repository: set the key in this repo's keystore.
- Network config is in `hardhat.config.ts` (`hadrian`; add an entry for another chain).

All tasks run as `npx hardhat <task> --network hadrian`.

---

## 3. Deploying the protocol from scratch

Order matters — reserves depend on the core stack, the oracle depends on
reserves, flash-loan smoke depends on liquidity.

```bash
# 1. Core stack — PoolAddressesProvider → ACLManager → IRS → Pool (proxy) →
#    PoolConfigurator → aToken/debtToken impls → DataProvider. (8 steps.)
npx hardhat deploy --network hadrian

# 2. View helper the UI needs for getReservesData / getUserReservesData.
npx hardhat deploy-ui-helpers --network hadrian

# 3. (optional) Mock collateral tokens + faucet (HEAT/SALT/MILK/OIL); not used on the current market.
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

Every task writes resulting addresses to `deployments/<network>.json`. To
publish them, open a pull request on
[`rome-registry`](https://github.com/rome-protocol/rome-registry)
(`apps/aave/<chainId>-<slug>.json` + `chains/<...>/contracts.json`).

---

## 4. Operational tasks (day-2)

| Task / script | What it does |
|---|---|
| `hardhat gamut --network hadrian` | Stress gamut: Aave V3 × cached wrappers (supply/borrow/repay/withdraw across reserves). Operator tooling: it needs `REGISTRY_API_BASE` set to an endpoint that serves the registry's `/api/chains`; no public endpoint is named here, and the other tasks and scripts do not need it. |
| `hardhat gamut-extras --network hadrian` | Smoke: **multi-asset flashLoan** (pre-approved receiver) + setUserEMode + repayWithATokens. Expect all PASS. |
| `hardhat deploy-flash-receiver --network hadrian [--demo true]` | Deploy + `init()` a pre-approved flash-loan receiver. `--demo true` deploys the no-initiator-check `DemoOpenMultiFlashReceiver` the public UI uses — **hard-gated to a testnet chainId allowlist** (see §6). |
| `hardhat check-registry-drift --network hadrian [--registry <path>]` | Read-only: diff `deployments/<net>.json` + live on-chain oracle sources against the registry (`apps/aave/` + `chains/contracts.json`). Exits non-zero on drift; use as a pre-publish gate. |
| `hardhat seed-pool --network hadrian` | Supply deployer-held wrapper liquidity into the pool (borrow/flash-loan funds) |
| `hardhat setup-emodes --network hadrian` | Configure E-mode categories + bind assets |
| `hardhat reset-oracle-prices --network hadrian` | Restore mock-priced reserves to canonical mock prices (after a demo price drop). Skips any reserve currently on a BOOK shim from `hadrian-oracle-shims.json` |
| `scripts/deploy-book-shims.ts` | Deploy the BOOK shims from the registry; writes `deployments/hadrian-oracle-shims.json` (see §5) |
| `scripts/switch-oracle-to-book.ts` | Point the listed reserves at the shims in one `setAssetSources` call (see §5) |
| `scripts/revert-oracle-to-constants.ts` | Point the listed reserves back at their constant aggregators |
| `scripts/measure-price-cost.ts` | Read-only: estimateGas + account count for borrow / withdraw / liquidationCall (see §5) |

Scripts run via `npx hardhat run scripts/<name>.ts --network hadrian`.

---

## 5. Oracle — PriceBook BOOK feeds through resilient shims

`AaveOracle` reads one Chainlink-V2 `latestAnswer()` source per asset. Rome's
live prices are the PriceBook (`0xac3d8004…`) `*/USD-BOOK` adapters (USDC, ETH,
SOL, BTC; keeper-refreshed, `maxStaleness` 3600 s). They are Chainlink-V3
(`latestRoundData`) and have no `latestAnswer()`, so each reserve needs one
`contracts/misc/BookFeedToV2ShimResilient.sol`: primary = the BOOK adapter,
fallback = a fixed 8-decimal aggregator.

**Fall-back rule:** when the book stalls (adapter
reverts `StalePriceFeed`, or answers <= 0) the shim answers the fixed fallback
price instead of reverting, so a stalled book never breaks `getReservesData`
or `getUserAccountData`. The fallback is the live book price read at deploy
time, so a stalled book freezes the price at that value. Fine for a testnet;
not for a live-money market (see §9).

Addresses are never hard-coded: `scripts/deploy-book-shims.ts` reads each
`*/USD-BOOK` address from the public registry `rome-protocol/rome-registry` (`chains/200010-hadrian/oracle.json`)
and the wBTC token from `tokens.json`, via `gh api`.

```bash
# 1. Deploy shims for wUSDC / wETH / wSOL / wBTC. Aborts unless each shim answers
#    the live book value. Writes deployments/hadrian-oracle-shims.json (commit it).
npx hardhat run scripts/deploy-book-shims.ts --network hadrian

# 2. Measure before and after the switch (read-only, no key):
MEASURE_USER=0x<address> npx hardhat run scripts/measure-price-cost.ts

# 3. Switch: ONE AaveOracle.setAssetSources call for the listed reserves
#    (prints getAssetPrice before and after). Run as the oracle admin.
npx hardhat run scripts/switch-oracle-to-book.ts --network hadrian

# Undo: back to the constant aggregators in deployments/hadrian.json
npx hardhat run scripts/revert-oracle-to-constants.ts --network hadrian
```

`scripts/measure-price-cost.ts` prints `eth_estimateGas` and the Solana account
count (`rome_emulateCallAccounts [tx, payerBase58]`) for `borrow`,
withdraw-with-debt and `liquidationCall`. The oracle is read on those three,
not on plain `repay`.
`eth_estimateGas` is Rome gas, not Solana CU, and atomic calls often floor at
21000, so it cannot show the price read's CU: take CU from `computeUnitsConsumed`
in the receipts of real sends on both lanes. `rome_emulateCallAccounts` is the
Solana-lane discovery method: for that lane set `MEASURE_USER` to the user's
synthetic address and `MEASURE_PAYER` to their Solana wallet; for the EVM lane use
the EOA. Keep the same payer before and after the switch.
After switching, update the registry `apps/aave` `priceFeed` / `priceFeedKind`.

The older shims `0xd3662b9a…`, `0xaef856d2…`, `0x520799ab…` wrap a retired
300 s book and only ever return the constants. They are dead: do not re-point
to them.

### Listing wBTC (4th reserve)

wBTC (registry `tokens.json`; 9 decimals, ERC20SPLFactory
wrapper) exists and BTC/USD-BOOK serves a live price. Steps, in order:

1. Deploy the shims (above); this includes the wBTC shim. The wBTC address
   comes from the registry `tokens.json`.
2. `npx hardhat init-reserve --network hadrian --asset <wBTC from registry> --symbol wBTC --decimals 9 --price-feed <wBTC shim from hadrian-oracle-shims.json> ...`
   (`--price-feed` uses the shim as the source; no MockAggregator is deployed).
3. The deployer grants `approve_spl` on the wrapper, then `hardhat seed-pool`.
4. **Measure before users see it.** The limit is 64 accounts per tx and
   each active collateral adds about 7.5-8 accounts. Four active collaterals have
   never been measured: from a wallet holding all 4 collaterals, measure
   borrow and withdraw-with-debt on both lanes (`scripts/measure-price-cost.ts`).
   If it goes over the limit, set wBTC's LTV/LT to 0 or freeze the reserve.
5. Only then make it visible: add the wBTC entries under `apps/aave` and
   `chains/contracts.json` in the registry.
6. Demo: add wBTC to `lib/aave-hadrian.json` `reserves[]` in the
   [`rome-aave-v3-demo`](https://github.com/rome-protocol/rome-aave-v3-demo) repo (`displaySymbol` and
   the at-risk bonus, which otherwise falls back to 0 %), then rebuild the demo.

The older OG-V2 Pyth path is dead on Hadrian (Hermes 401 since 2026-09-06). The
raw `pyth` feeds (60 s window) and all `-CACHED` / `-CACHEDPYTH` feeds do not
serve reliably: use `*/USD-BOOK` only.

## 6. Flash loans — the pre-approve pattern

Single-asset `flashLoanSimple` works out of the box. **Multi-asset
`Pool.flashLoan` (2+ cached wrappers) needed one Rome-specific change** —
not a protocol change, a receiver-design change.

Solana caps accounts per transaction (64). Rome's
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
- `DemoOpenMultiFlashReceiver.sol`
  — **demo-only**, no initiator whitelist so any wallet can drive the public
  demo. Testnet-only; production must use the hardened base. The
  `deploy-flash-receiver --demo` path is **mechanically gated**: it reads the
  live chainId and hard-fails unless it is in an explicit testnet allowlist
  (`DEMO_RECEIVER_TESTNET_CHAIN_IDS`), so the no-initiator receiver can never be
  shipped to a mainnet chain by a stray flag.

Smoke it: `npx hardhat gamut-extras --network hadrian`. Account
counts are measured by `scripts/measure-price-cost.ts`, not by `gamut-extras`.

---

## 7. Setting up a live liquidation demo

You can't liquidate your own position, and Aave/the demo run **no keeper bot**
— liquidation is a manual `Pool.liquidationCall`. To demo it you need a
*different* account underwater. The 0x81e7 market lists only
wUSDC/wETH/wSOL, and after the BOOK switch they follow the live market and can't
be moved by hand. Moving a price needs the reserve on a constant source
(`scripts/revert-oracle-to-constants.ts`); otherwise wait for a position that goes
under water from real market moves.

Caution: `hardhat reset-oracle-prices` skips reserves on a BOOK shim, but
`hardhat gamut` re-points their collateral and borrow
reserves to baseline MockAggregators at the start. After a gamut run, re-run
`scripts/switch-oracle-to-book.ts`.

---

## 8. Verification commands

```bash
# A price reads sane through the oracle (8-dec USD):
cast call 0x4736549aB02e6c6b7083b7625464368E203287E4 \
  "getAssetPrice(address)(uint256)" <underlying> --rpc-url https://hadrian.testnet.romeprotocol.xyz/

# A user's account health:
cast call 0x81e7e7e4cBC2b5a55C2dE1d3dFCf87C0cF867520 \
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
  + set a real treasury before reserve factor > 0.
- **Resilient oracle shim falls back to a fixed price.**
  `BookFeedToV2ShimResilient` returns a fixed aggregator price on any BOOK adapter
  revert (keeper lapse) so the market never reverts — correct for a testnet
  demo, **dangerous on a live market** (a stale / owner-settable price feeding
  liquidations). `latestAnswer()` is `view`, so it cannot emit on fallback;
  observability is an off-chain staleness alert on the price feed. Mainnet: don't
  use the resilient variant — wire a real second source and let
  `PriceOracleSentinel` gate liquidations on staleness.
- **Demo flash receiver has no initiator check.** `DemoOpenMultiFlashReceiver`
  is testnet/demo-only and now **mechanically gated** to a testnet chainId
  allowlist in `deploy-flash-receiver` (§6). Mainnet apps inherit
  `PreApprovedFlashReceiverBase` (initiator whitelist).
- **MockAggregator prices are frozen** for HEAT/SALT/MILK/OIL (invented demo
  tokens). Mainnet markets list only assets with a real price feed.

## 10. Related

- Demo UI + user guide: [`rome-aave-v3-demo`](https://github.com/rome-protocol/rome-aave-v3-demo)
- Registry entry: `apps/aave/200010-hadrian.json` in
  [`rome-registry`](https://github.com/rome-protocol/rome-registry)
