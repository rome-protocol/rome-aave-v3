import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatIgnitionEthers from "@nomicfoundation/hardhat-ignition-ethers";
import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";

import deployTask from "./tasks/deploy.js";
import deployFaucetTask from "./tasks/deploy-faucet.js";
import deployUiHelpersTask from "./tasks/deploy-ui-helpers.js";
import initReserveTask from "./tasks/init-reserve.js";
import gamutTask from "./tasks/gamut.js";
import gamutExtrasTask from "./tasks/gamut-extras.js";
import resetOraclePricesTask from "./tasks/reset-oracle-prices.js";
import seedPoolTask from "./tasks/seed-pool.js";
import setupEmodesTask from "./tasks/setup-emodes.js";
import deployAuxTask from "./tasks/deploy-aux.js";
import deployFlashReceiverTask from "./tasks/deploy-flash-receiver.js";
import checkRegistryDriftTask from "./tasks/check-registry-drift.js";

// Canonical Aave V3 source from @aave-dao/aave-v3-origin@3.6.0 (slim first-cut)
// vendored into contracts/. Same architectural principle as rome-uniswap-v3:
// modify the token (SPL_ERC20_cached), keep the lending protocol canonical.
//
// Compiler settings match Aave's foundry.toml: solc 0.8.27, optimizer.runs=200,
// metadata.bytecodeHash=none, evm_version=shanghai.
const optimizer = { enabled: true, runs: 200 };

export default defineConfig({
  plugins: [hardhatEthers, hardhatIgnitionEthers, hardhatKeystore, hardhatVerify],
  solidity: {
    compilers: [
      {
        version: "0.8.27",
        settings: {
          optimizer,
          evmVersion: "shanghai",
          metadata: { bytecodeHash: "none" },
        },
      },
    ],
    overrides: {},
  },
  networks: {
    aurelius: {
      type: "http",
      chainType: "l1",
      chainId: 30001,
      url: "https://aurelius.real-testnet.romeprotocol.xyz/",
      accounts: [configVariable("AURELIUS_PRIVATE_KEY")],
    },

    augustus: {
      type: "http",
      chainType: "l1",
      chainId: 200001,
      url: "https://augustus.testnet.romeprotocol.xyz/",
      accounts: [configVariable("AUGUSTUS_PRIVATE_KEY")],
    },

    marcus: {
      type: "http",
      chainType: "l1",
      chainId: 121301,
      url: "https://marcus.devnet.romeprotocol.xyz/",
      accounts: [configVariable("MARCUS_PRIVATE_KEY")],
    },

    hadrian: {
      type: "http",
      chainType: "l1",
      chainId: 200010,
      url: "https://hadrian.testnet.romeprotocol.xyz/",
      accounts: [configVariable("HADRIAN_PRIVATE_KEY")],
    },
  },
  chainDescriptors: {},
  verify: {
    blockscout: { enabled: true },
    etherscan: { enabled: false },
    sourcify: { enabled: true },
  },
  tasks: [deployTask, deployFaucetTask, deployUiHelpersTask, deployAuxTask, deployFlashReceiverTask, checkRegistryDriftTask, initReserveTask, gamutTask, gamutExtrasTask, resetOraclePricesTask, seedPoolTask, setupEmodesTask],
});
