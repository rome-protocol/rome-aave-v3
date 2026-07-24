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
the Hardhat configuration, the deploy/gamut tasks under `tasks/`, and the
cached-wrapper test receivers under `contracts/test/`.

## Build

```bash
yarn install
yarn hardhat compile
```

## License

Rome-authored scaffolding is MIT; the vendored Aave V3 code retains its upstream
licenses (BUSL-1.1 / MIT / LGPL-3.0) per each file's SPDX header. See
[LICENSE](./LICENSE) and
[aave-dao/aave-v3-origin](https://github.com/aave-dao/aave-v3-origin) for the
Business Source License parameters.

## Building on Rome with an agent
See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.
