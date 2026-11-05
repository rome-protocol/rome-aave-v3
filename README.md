# rome-aave-v3

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.

- **Single state** — EVM contracts and Solana programs share one state; no bridging or sync delay.
- **Atomic CPI access** — Solidity calls any Solana program directly (SPL Token, Meteora, …) inside one atomic transaction.
- **App Sovereignty** — each app runs its own EVM chain with a custom gas token and captures its own fee revenue.

Aave V3.6 on Rome: a slim cut of [aave-dao/aave-v3-origin](https://github.com/aave-dao/aave-v3-origin) (the contracts are vendored unmodified from main at commit 1e3d70c, February 2026, after the v3.6.0 release; four files are from the v3.6.0 tag, see `NOTICE`), deployed against Rome's `SPL_ERC20_cached` SPL-token wrappers so an EVM lending market composes natively with Solana liquidity. It is live on Hadrian, Rome's public testnet (chain 200010): four reserves (wUSDC, wETH, wSOL, wBTC).

The Aave V3 protocol contracts are vendored under `contracts/`, each file keeping its upstream SPDX license header. Rome's additions:

- `contracts/misc/RomePriceOracle.sol`: the pool's price oracle. It reads Rome's PriceBook entries directly and answers a fixed fallback price when an entry is stale or missing, so a stalled book never reverts the market. `PriceBookEntryShim.sol` and `BookFeedToV2ShimResilient.sol` are the price sources used with `AaveOracle`, the previous oracle.
- `contracts/test/`: the pre-approved flash-loan receivers, a faucet and test tokens, and price-book test doubles.
- `tasks/` and `scripts/`: the Hardhat tasks that deploy and list the market, and the oracle, reserve-cap and wBTC tools.
- `test/`: three unit tests for the oracle contracts.
- `deployments/`: the addresses of the Hadrian market and its oracle records.

Start with [`docs/AAVE-V3-ON-ROME.md`](./docs/AAVE-V3-ON-ROME.md): what runs, the live addresses, how to deploy, the oracle, and the flash-loan pattern.

## Build

```bash
yarn install --frozen-lockfile
npx hardhat compile
```

Tests run as scripts, for example `npx hardhat run test/rome-price-oracle.test.ts`.

## License

Rome's own code is under the Rome Protocol license, in [LICENSE](./LICENSE): personal, non-commercial use, and commercial use by written permission. The vendored third-party code keeps its own licenses, per each file's `SPDX-License-Identifier` header: the Aave V3 core is BUSL-1.1, other Aave files and the OpenZeppelin and Chainlink code are MIT, the Gnosis `GPv2SafeERC20` is LGPL-3.0-or-later, and WETH9 is GPL-3.0-or-later (licence notice in its header). [NOTICE](./NOTICE) lists them, and the license texts are in [`LICENSES/`](./LICENSES). The BUSL-1.1 terms, including the Additional Use Grant and the Change Date, are Aave DAO's, in `LICENSES/BUSL-1.1-aave-v3-origin`.

## Building on Rome with an agent

See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.
