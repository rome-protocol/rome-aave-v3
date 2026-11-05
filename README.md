# rome-aave-v3

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.


- **Single state** — EVM contracts and Solana programs share one state; no bridging or sync delay.
- **Atomic CPI access** — Solidity calls any Solana program directly (SPL Token, Meteora, …) inside one atomic transaction.
- **App Sovereignty** — each app runs its own EVM chain with a custom gas token and captures its own fee revenue.

Canonical Aave V3 on Rome Protocol — a slim first-cut of
[aave-dao/aave-v3-origin@3.6.0](https://github.com/aave-dao/aave-v3-origin),
deployed against Rome's `SPL_ERC20_cached` SPL-token wrappers so an EVM lending
market composes natively with Solana liquidity.

The Aave V3 protocol contracts are vendored under `contracts/` byte-identical to
upstream — each file keeps its upstream SPDX license header. Rome's additions are
the Hardhat configuration, the deploy/gamut tasks under `tasks/`, the oracle
scripts under `scripts/`, the price shim `contracts/misc/BookFeedToV2ShimResilient.sol`,
the receivers and mocks under `contracts/test/`, and the unit test under `test/`.

## What is in this repo

- **Contracts**: Aave V3.6 (slim cut) plus `BookFeedToV2ShimResilient`, which gives
  `AaveOracle` the live Rome PriceBook price and falls back to a fixed price when the
  book is stale.
- **Tasks and scripts**: deploy the stack, list reserves (`init-reserve`, with
  `--price-feed` to use a shim as the price source), smoke gamuts, and the oracle
  scripts (`deploy-book-shims`, `switch-oracle-to-book`, `revert-oracle-to-constants`,
  `measure-price-cost`).
- **Deployment records**: `deployments/hadrian.json` and
  `deployments/hadrian-oracle-shims.json` (public addresses on Hadrian, chain 200010).
- **Docs**: [`docs/AAVE-V3-ON-ROME.md`](docs/AAVE-V3-ON-ROME.md) covers the protocol,
  deploy, oracle, flash-loan pattern and day-2 operations.

The web app that sits on these contracts is a separate repo:
[`rome-aave-v3-demo`](https://github.com/rome-protocol/rome-aave-v3-demo).

## Build

```bash
yarn install --frozen-lockfile
yarn hardhat compile
```

## License

Rome-authored code (the Hardhat configuration, `tasks/`, `scripts/`, `test/`, the
price shim and `contracts/test/`) is under Rome Protocol's licence (personal, non-commercial use; see [LICENSE](./LICENSE)).
The vendored Aave V3 code retains its upstream licenses (BUSL-1.1 / MIT / LGPL-3.0)
per each file's SPDX header. See
[aave-dao/aave-v3-origin](https://github.com/aave-dao/aave-v3-origin) for the
Business Source License parameters.

## Building on Rome with an agent
See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.
