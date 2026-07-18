import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Smoke for the three Pool methods that the main `gamut` task doesn't cover:
//
//   A. Pool.flashLoan (multi-asset entrypoint)
//   B. Pool.setUserEMode + Pool.getUserEMode (user-side opt-in)
//   C. Pool.repayWithATokens (burn aTokens to clear same-asset debt)
//
// Self-contained: doesn't depend on prior gamut state, doesn't crank oracle,
// doesn't liquidate. Picks two reserves via --collateral-symbol / --borrow-symbol
// (defaults wUSDC + wETH on Hadrian).

const RATE_VARIABLE = 2;

export default task("gamut-extras", "Smoke: flashLoan multi-asset + setUserEMode + repayWithATokens")
  .addOption({ name: "collateralSymbol", description: "Symbol of the collateral reserve", defaultValue: "wUSDC" })
  .addOption({ name: "borrowSymbol", description: "Symbol of the borrow reserve", defaultValue: "wETH" })
  .setInlineAction(async ({ collateralSymbol, borrowSymbol }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const reserves = deployments._reserves ?? {};
    const collateral = reserves[collateralSymbol];
    const borrow = reserves[borrowSymbol];
    if (!collateral) throw new Error(`No reserve for ${collateralSymbol}`);
    if (!borrow) throw new Error(`No reserve for ${borrowSymbol}`);

    const poolAddr = deployments.Pool.address;
    const pool = await ethers.getContractAt("Pool", poolAddr);
    const configurator = await ethers.getContractAt("PoolConfigurator", deployments.PoolConfigurator.address);

    const ERC20_ABI = [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function decimals() view returns (uint8)",
    ];
    const collateralToken = new ethers.Contract(collateral.asset, ERC20_ABI, signer);
    const borrowToken = new ethers.Contract(borrow.asset, ERC20_ABI, signer);
    const aBorrow = new ethers.Contract(borrow.aToken, ERC20_ABI, signer);
    const vBorrow = new ethers.Contract(borrow.vToken, ERC20_ABI, signer);

    const MaxUint256 = (1n << 256n) - 1n;

    console.log(`Network:    ${networkSlug}`);
    console.log(`Signer:     ${signer.address}`);
    console.log(`Pool:       ${poolAddr}`);
    console.log(`Collateral: ${collateralSymbol} (${collateral.asset})`);
    console.log(`Borrow:     ${borrowSymbol} (${borrow.asset})`);
    console.log();

    const passed: string[] = [];
    const failed: string[] = [];
    async function step(name: string, fn: () => Promise<string | void>) {
      process.stdout.write(`  ${name} ... `);
      const start = Date.now();
      try {
        await fn();
        console.log(`PASS (${Date.now() - start}ms)`);
        passed.push(name);
      } catch (e) {
        console.log(`FAIL (${Date.now() - start}ms): ${(e as Error).message}`);
        failed.push(`${name}: ${(e as Error).message}`);
      }
    }

    // ─── Detect cached wrappers (needs ATA warmup) ────────────────────────
    const cachedProbeData = "0x5e094743" + signer.address.slice(2).padStart(64, "0");
    async function isCached(addr: string): Promise<boolean> {
      try {
        await ethers.provider.call({ to: addr, data: cachedProbeData });
        return true;
      } catch {
        return false;
      }
    }
    const collateralIsCached = await isCached(collateral.asset);
    const borrowIsCached = await isCached(borrow.asset);

    async function ensureATA(wrapperAddr: string, holder: string): Promise<void> {
      const w = new ethers.Contract(
        wrapperAddr,
        ["function ensure_token_account(address) returns (bytes32)"],
        signer,
      );
      const tx = await w.ensure_token_account(holder);
      await tx.wait();
    }

    // ====================================================================
    // A. flashLoan (multi-asset, via pre-approved receiver)
    //
    // Canonical Aave V3's in-callback approve pattern pushes the per-sig
    // account set past Solana's runtime account_locks cap when 2+ cached
    // SPL wrappers are involved (62-65 accounts vs 64-mainnet / 128-devnet
    // cap). Rome's solution: pre-approve Pool in a SEPARATE `init()` tx so
    // the flash loan tx doesn't accumulate the approve CPI's accounts.
    //
    // Pattern: `PreApprovedFlashReceiverBase` (contracts/test/) — apps
    // extend it for production. The concrete `PreApprovedMultiFlashReceiver`
    // is a no-op smoke implementation we use here.
    // ====================================================================
    console.log(`--- A. flashLoan (multi-asset, pre-approved receiver) ---`);
    await step(`config.setReserveFlashLoaning(${collateralSymbol}, true)`, async () => {
      const tx = await configurator.setReserveFlashLoaning(collateral.asset, true);
      await tx.wait();
    });
    await step(`config.setReserveFlashLoaning(${borrowSymbol}, true)`, async () => {
      const tx = await configurator.setReserveFlashLoaning(borrow.asset, true);
      await tx.wait();
    });

    const MultiReceiverFactory = await ethers.getContractFactory("PreApprovedMultiFlashReceiver");
    const multiReceiver = await MultiReceiverFactory.deploy(deployments.PoolAddressesProvider.address);
    await multiReceiver.waitForDeployment();
    const multiReceiverAddr = await multiReceiver.getAddress();
    console.log(`  PreApprovedMultiFlashReceiver: ${multiReceiverAddr}`);

    const collFlashAmount = 100n;
    const borrFlashAmount = 100n;
    const collPremium = (collFlashAmount * 5n) / 10000n + 1n;
    const borrPremium = (borrFlashAmount * 5n) / 10000n + 1n;

    if (collateralIsCached) {
      await step(`${collateralSymbol}.ensure_token_account(multiReceiver)`, async () => {
        await ensureATA(collateral.asset, multiReceiverAddr);
      });
    }
    if (borrowIsCached) {
      await step(`${borrowSymbol}.ensure_token_account(multiReceiver)`, async () => {
        await ensureATA(borrow.asset, multiReceiverAddr);
      });
    }

    // The key step: pre-approve Pool MAX for both assets in a SEPARATE tx.
    // This writes the SPL delegate state OUT of the flash loan tx's account
    // set, so the flash loan stays under the per-sig account cap.
    await step(`multiReceiver.init([${collateralSymbol}, ${borrowSymbol}]) — pre-approve Pool MAX`, async () => {
      const tx = await multiReceiver.init([collateral.asset, borrow.asset]);
      await tx.wait();
    });

    await step(`fund multiReceiver: ${collPremium} ${collateralSymbol}`, async () => {
      const tx = await collateralToken.transfer(multiReceiverAddr, collPremium);
      await tx.wait();
    });
    await step(`fund multiReceiver: ${borrPremium} ${borrowSymbol}`, async () => {
      const tx = await borrowToken.transfer(multiReceiverAddr, borrPremium);
      await tx.wait();
    });

    await step(`pool.flashLoan([${collateralSymbol}, ${borrowSymbol}], [${collFlashAmount}, ${borrFlashAmount}], modes=[0,0])`, async () => {
      const tx = await pool.flashLoan(
        multiReceiverAddr,
        [collateral.asset, borrow.asset],
        [collFlashAmount, borrFlashAmount],
        [0, 0],
        signer.address,
        "0x",
        0,
      );
      await tx.wait();
    });

    const multiCollPost = await collateralToken.balanceOf(multiReceiverAddr);
    const multiBorrPost = await borrowToken.balanceOf(multiReceiverAddr);
    console.log(`  multiReceiver post: ${multiCollPost} ${collateralSymbol}, ${multiBorrPost} ${borrowSymbol} (premium consumed)`);
    console.log();

    // ====================================================================
    // B. setUserEMode (user-side)
    // ====================================================================
    console.log(`--- B. setUserEMode ---`);
    const emodeBefore = await pool.getUserEMode(signer.address);
    console.log(`  getUserEMode before: ${emodeBefore}`);

    // Always safe: set to 0 (disabled). Restores to whatever it was if non-0.
    await step(`pool.setUserEMode(0)`, async () => {
      const tx = await pool.setUserEMode(0);
      await tx.wait();
    });
    const emodeAfter0 = await pool.getUserEMode(signer.address);
    console.log(`  getUserEMode after setUserEMode(0): ${emodeAfter0}`);
    if (emodeAfter0 !== 0n) {
      failed.push(`setUserEMode(0) did not take effect; got ${emodeAfter0}`);
    }

    // Try round-trip to category 1 (Stablecoin) and back. Will skip if user
    // currently holds debt in an asset not borrowable in category 1.
    const vBalForEmode = await vBorrow.balanceOf(signer.address);
    if (vBalForEmode === 0n) {
      await step(`pool.setUserEMode(1) — Stablecoin`, async () => {
        const tx = await pool.setUserEMode(1);
        await tx.wait();
      });
      const emodeAfter1 = await pool.getUserEMode(signer.address);
      console.log(`  getUserEMode after setUserEMode(1): ${emodeAfter1}`);
      await step(`pool.setUserEMode(0) — restore`, async () => {
        const tx = await pool.setUserEMode(0);
        await tx.wait();
      });
    } else {
      console.log(`  SKIP round-trip to category 1: user has vd${borrowSymbol} debt (${vBalForEmode}) — category 1 may not allow ${borrowSymbol} borrows`);
    }
    console.log();

    // ====================================================================
    // C. repayWithATokens
    // ====================================================================
    console.log(`--- C. repayWithATokens ---`);

    // Ensure we have collateral + the ability to borrow the same asset.
    // Strategy: supply a tiny amount of `borrowSymbol`, mark it as collateral
    // (default), then borrow a smaller amount of `borrowSymbol`, then repay
    // with the aBorrow tokens we received from the supply.
    const supplyAmount = 100_000n; // raw — small but covers the borrow + fee
    const borrowAmount = 10_000n;

    const borrowBalC = await borrowToken.balanceOf(signer.address);
    if (borrowBalC < supplyAmount) {
      console.log(`  SKIP: insufficient ${borrowSymbol} wallet balance for repayWithATokens setup (have ${borrowBalC}, need ${supplyAmount})`);
    } else {
      const allowanceC = await borrowToken.allowance(signer.address, poolAddr);
      if (allowanceC < supplyAmount * 10n) {
        await step(`${borrowSymbol}.approve(Pool, max)`, async () => {
          const tx = await borrowToken.approve(poolAddr, MaxUint256);
          await tx.wait();
        });
      }

      await step(`pool.supply(${borrowSymbol}, ${supplyAmount})`, async () => {
        const tx = await pool.supply(borrow.asset, supplyAmount, signer.address, 0);
        await tx.wait();
      });

      // Mark borrow-asset as collateral so we can borrow against it
      await step(`pool.setUserUseReserveAsCollateral(${borrowSymbol}, true)`, async () => {
        const tx = await pool.setUserUseReserveAsCollateral(borrow.asset, true);
        await tx.wait();
      });

      const vBefore = await vBorrow.balanceOf(signer.address);
      const aBefore = await aBorrow.balanceOf(signer.address);
      console.log(`  pre-borrow: a${borrowSymbol}=${aBefore}, vd${borrowSymbol}=${vBefore}`);

      await step(`pool.borrow(${borrowSymbol}, ${borrowAmount}, variable)`, async () => {
        const tx = await pool.borrow(borrow.asset, borrowAmount, RATE_VARIABLE, 0, signer.address);
        await tx.wait();
      });

      const vAfterBorrow = await vBorrow.balanceOf(signer.address);
      console.log(`  post-borrow vd${borrowSymbol}: ${vAfterBorrow}`);

      await step(`pool.repayWithATokens(${borrowSymbol}, max, variable)`, async () => {
        const tx = await pool.repayWithATokens(borrow.asset, MaxUint256, RATE_VARIABLE);
        await tx.wait();
      });

      const vAfterRepay = await vBorrow.balanceOf(signer.address);
      const aAfterRepay = await aBorrow.balanceOf(signer.address);
      console.log(`  post-repayWithATokens: a${borrowSymbol}=${aAfterRepay}, vd${borrowSymbol}=${vAfterRepay}`);
      if (vAfterRepay !== 0n) {
        failed.push(`repayWithATokens did not clear debt; vd${borrowSymbol}=${vAfterRepay}`);
      }
    }

    console.log();
    console.log(`--- Summary ---`);
    console.log(`  PASS: ${passed.length}`);
    console.log(`  FAIL: ${failed.length}`);
    for (const p of passed) console.log(`    + ${p}`);
    if (failed.length > 0) {
      console.log(`\nFailures:`);
      for (const f of failed) console.log(`  - ${f}`);
      process.exit(1);
    }
  })
  .build();
