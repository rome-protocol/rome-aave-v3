import * as fs from "fs";
import * as path from "path";
import { task } from "hardhat/config";

// Stress gamut for canonical Aave V3 against SPL_ERC20_cached wrappers.
//
// Exercises the supply / borrow / repay / withdraw / liquidation surface
// against two reserves. Captures per-action Solana metrics (iter sigs,
// CU, max heap, slot span) via rome_solanaTxForEvmTx + Rome's Cherry
// follower — same pattern as rome-uniswap-v3 gamut.
//
// Coverage:
//   1. supply(collateralAsset, collateralAmount) → mint aToken
//   2. supply(borrowAsset, lendAmount) → liquidity for the borrow side
//   3. setUserUseReserveAsCollateral(collateralAsset, true)
//   4. borrow(borrowAsset, borrowAmount, mode=2) → mint vToken
//   5. repay(borrowAsset, max) → burn vToken
//   6. withdraw(collateralAsset, max) → burn aToken
//
// Reserve assets (wrapper address + decimals) are resolved live from the registry
// API's /api/chains by symbol — the same source the app reads — so the gamut
// always tests the wrappers that are live, never a stale local copy. aToken/vToken
// are read on-chain via Pool.getReserveData; the Aave stack addresses still come
// from deployments/<network>.json. Reserves must be pre-initialized via
// `hardhat init-reserve`. Set REGISTRY_API_BASE to override the registry host.

const RATE_VARIABLE = 2;

export default task("gamut", "Stress gamut: Aave V3 × SPL_ERC20_cached wrappers")
  .addOption({ name: "collateralSymbol", description: "Symbol of the collateral reserve (e.g., wUSDC)", defaultValue: "" })
  .addOption({ name: "borrowSymbol", description: "Symbol of the borrow reserve (e.g., wETH)", defaultValue: "" })
  .addOption({ name: "collateralAmount", description: "Raw amount of collateral to supply", defaultValue: "10000" })
  .addOption({ name: "lendAmount", description: "Raw amount of borrow-asset liquidity to supply", defaultValue: "10000" })
  .addOption({ name: "borrowAmount", description: "Raw amount to borrow", defaultValue: "500" })
  .setInlineAction(async ({ collateralSymbol, borrowSymbol, collateralAmount, lendAmount, borrowAmount }, hre) => {
    const { ethers, networkName } = await hre.network.connect();
    const [signer] = await ethers.getSigners();

    if (!collateralSymbol || !borrowSymbol) {
      throw new Error("--collateral-symbol and --borrow-symbol are required");
    }
    if (collateralSymbol === borrowSymbol) {
      throw new Error("collateral and borrow symbols must differ for a meaningful gamut");
    }

    const networkSlug = networkName ?? "unknown";
    const deploymentsPath = path.join("deployments", `${networkSlug}.json`);
    if (!fs.existsSync(deploymentsPath)) {
      throw new Error(`No deployments file at ${deploymentsPath}. Run \`hardhat deploy\` first.`);
    }
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    const poolAddr = deployments.Pool.address;
    const pool = await ethers.getContractAt("Pool", poolAddr);

    // --- Resolve reserves from the live registry, not the local deployments file ---
    // The wrapper (asset) address + decimals come from the registry API's /api/chains — the
    // same source the app reads — so the gamut tracks whatever wrappers are live.
    // (Hadrian migrated every SPL wrapper to a new #240 set; a stale local copy
    // would silently test dead contracts — which is exactly what hid prior runs.)
    // aToken/vToken are read on-chain from the Pool. Only the Aave stack addresses
    // stay local (deploy artifacts, not in the registry). REGISTRY_API_BASE overrides.
    const apiBase = (process.env.REGISTRY_API_BASE || "").replace(/\/$/, "");
    if (!apiBase) throw new Error("Set REGISTRY_API_BASE to your registry API endpoint (the /api/chains host).");
    const chainId = Number((hre.network as any).config?.chainId);
    // Test-baseline USD price per canonical asset. The registry carries assetRef but
    // no price; the gamut deterministically resets + 10x-cranks the oracle off this
    // baseline, so it must be stable across runs — never a live feed.
    const BASELINE_USD: Record<string, number> = { usdc: 1, usdt: 1, eth: 3000, btc: 60000, sol: 200 };

    const chainsUrl = `${apiBase}/api/chains`;
    const chainsRes = await fetch(chainsUrl);
    if (!chainsRes.ok) throw new Error(`registry fetch failed: GET ${chainsUrl} → HTTP ${chainsRes.status}`);
    const chainsBody: any = await chainsRes.json();
    const chainsArr: any[] = Array.isArray(chainsBody) ? chainsBody : (chainsBody.chains ?? []);
    const chainEntry = chainsArr.find((c) => Number(c?.chainId) === chainId);
    if (!chainEntry) throw new Error(`chain ${chainId} not found in ${chainsUrl}`);
    const registryTokens: any[] = chainEntry.tokens ?? [];

    async function resolveReserve(symbol: string) {
      const token = registryTokens.find((t) => t.symbol === symbol && t.kind === "spl_wrapper");
      if (!token) throw new Error(`no spl_wrapper '${symbol}' for chain ${chainId} in ${chainsUrl} — is it registered?`);
      const rd = await pool.getReserveData(token.address);
      const aToken: string = rd.aTokenAddress;
      const vToken: string = rd.variableDebtTokenAddress;
      if (aToken === ethers.ZeroAddress) {
        throw new Error(`reserve '${symbol}' (${token.address}) is registered but NOT listed on the Pool — run \`hardhat init-reserve --symbol ${symbol} --asset ${token.address} --decimals ${token.decimals} --price-usd <p>\``);
      }
      const priceUsd = BASELINE_USD[String(token.assetRef)] ?? 1;
      return { asset: token.address as string, aToken, vToken, decimals: Number(token.decimals), priceUsd, assetRef: String(token.assetRef) };
    }

    const collateral = await resolveReserve(collateralSymbol);
    const borrow = await resolveReserve(borrowSymbol);

    console.log(`Network: ${networkSlug}`);
    console.log(`Signer:  ${signer.address}`);
    console.log(`Pool:    ${poolAddr}`);
    console.log(`Registry: ${chainsUrl} (chain ${chainId})`);
    console.log(`Collateral: ${collateralSymbol} @ ${collateral.asset} (aToken ${collateral.aToken}) [assetRef ${collateral.assetRef}, $${collateral.priceUsd}]`);
    console.log(`Borrow:     ${borrowSymbol} @ ${borrow.asset} (vToken ${borrow.vToken}) [assetRef ${borrow.assetRef}, $${borrow.priceUsd}]`);
    console.log(`Amounts: collateral=${collateralAmount}, lend=${lendAmount}, borrow=${borrowAmount}`);

    const MaxUint256 = (1n << 256n) - 1n;
    const collateralAmt = BigInt(collateralAmount);
    const lendAmt = BigInt(lendAmount);
    const borrowAmt = BigInt(borrowAmount);
    const ERC20_ABI = [
      "function balanceOf(address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ];
    const collateralToken = new ethers.Contract(collateral.asset, ERC20_ABI, signer);
    const borrowToken = new ethers.Contract(borrow.asset, ERC20_ABI, signer);
    const aColl = new ethers.Contract(collateral.aToken, ERC20_ABI, signer);
    const vBorrow = new ethers.Contract(borrow.vToken, ERC20_ABI, signer);

    type Metric = {
      name: string;
      wallMs: number;
      txHash?: string;
      iterSigs?: number;
      totalCU?: number;
      maxHeap?: number;
      slotSpan?: number;
    };
    const metrics: Metric[] = [];
    const passed: string[] = [];
    const failed: string[] = [];

    const ROME_RPC = (hre.network as any).config?.url ?? "https://hadrian.testnet.romeprotocol.xyz/";
    const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

    async function rpc(url: string, method: string, params: any[]): Promise<any> {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const json: any = await r.json();
      return json.result;
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function getSolanaTxWithRetry(sig: string): Promise<any> {
      for (const delay of [0, 1000, 2000, 3000, 5000]) {
        if (delay > 0) await sleep(delay);
        const tx: any = await rpc(SOLANA_RPC, "getTransaction", [
          sig,
          { maxSupportedTransactionVersion: 0, encoding: "json" },
        ]);
        if (tx) return tx;
      }
      return null;
    }

    async function captureTxMetrics(txHash: string): Promise<Partial<Metric>> {
      try {
        const sigs: string[] = (await rpc(ROME_RPC, "rome_solanaTxForEvmTx", [txHash])) ?? [];
        let totalCU = 0;
        let maxHeap = 0;
        let missing = 0;
        const slots: number[] = [];
        for (const sig of sigs) {
          const tx = await getSolanaTxWithRetry(sig);
          if (!tx) {
            missing += 1;
            continue;
          }
          slots.push(tx.slot);
          totalCU += tx.meta?.computeUnitsConsumed ?? 0;
          for (const l of (tx.meta?.logMessages ?? []) as string[]) {
            const m = l.match(/Program log: Heap (\d+)/);
            if (m) maxHeap = Math.max(maxHeap, parseInt(m[1], 10));
          }
        }
        return {
          txHash,
          iterSigs: sigs.length,
          totalCU: missing === sigs.length ? undefined : totalCU,
          maxHeap: missing === sigs.length ? undefined : maxHeap,
          slotSpan: slots.length > 0 ? Math.max(...slots) - Math.min(...slots) : 0,
        };
      } catch {
        return { txHash };
      }
    }

    async function step(name: string, fn: () => Promise<string | void>) {
      process.stdout.write(`  ${name} ... `);
      const start = Date.now();
      try {
        const maybeHash = await fn();
        const wallMs = Date.now() - start;
        const m: Metric = { name, wallMs };
        if (typeof maybeHash === "string" && maybeHash.length === 66) {
          const extra = await captureTxMetrics(maybeHash);
          Object.assign(m, extra);
        }
        metrics.push(m);
        const detail = m.iterSigs !== undefined
          ? `sigs=${m.iterSigs} CU=${m.totalCU?.toLocaleString()} heap=${m.maxHeap?.toLocaleString()} span=${m.slotSpan}`
          : "";
        console.log(`PASS (${wallMs}ms) ${detail}`);
        passed.push(`${name} (${wallMs}ms)`);
      } catch (e) {
        const wallMs = Date.now() - start;
        metrics.push({ name, wallMs });
        console.log(`FAIL (${wallMs}ms): ${(e as Error).message}`);
        failed.push(`${name}: ${(e as Error).message}`);
      }
    }

    console.log(`\n--- Pre-flight: balances + oracle reset ---`);
    const collBal = await collateralToken.balanceOf(signer.address);
    const borrBal = await borrowToken.balanceOf(signer.address);
    console.log(`  ${collateralSymbol}: ${collBal}`);
    console.log(`  ${borrowSymbol}:    ${borrBal}`);
    if (collBal < collateralAmt) console.log(`  WARN: ${collateralSymbol} balance < collateralAmount`);
    if (borrBal < lendAmt) console.log(`  WARN: ${borrowSymbol} balance < lendAmount`);

    // Reset both reserve oracle sources to their init-reserve prices.
    // Phase 8b cranks the borrow-asset oracle 10x to force a liquidation;
    // that source is sticky in AaveOracle across runs. Without this reset,
    // subsequent runs see the cranked price during Phase 5 borrow and
    // existing debt valuation jumps past the LTV ceiling → spurious revert.
    const aaveOracle = await ethers.getContractAt("AaveOracle", deployments.AaveOracle.address);
    const MockAggBaseline = await ethers.getContractFactory("MockAggregator");
    const collBaselinePx = BigInt(Math.round(collateral.priceUsd * 1e8));
    const borrBaselinePx = BigInt(Math.round(borrow.priceUsd * 1e8));
    const aggColl = await MockAggBaseline.deploy(collBaselinePx);
    await aggColl.waitForDeployment();
    const aggBorr = await MockAggBaseline.deploy(borrBaselinePx);
    await aggBorr.waitForDeployment();
    await (await aaveOracle.setAssetSources(
      [collateral.asset, borrow.asset],
      [await aggColl.getAddress(), await aggBorr.getAddress()],
    )).wait();
    console.log(`  oracle reset: ${collateralSymbol}=$${collateral.priceUsd}, ${borrowSymbol}=$${borrow.priceUsd}`);

    // If the user has leftover debt from a prior run, repay max BEFORE
    // entering Phase 1. Otherwise existing debt + LTV math collide with
    // the fresh approves and Phase 5's tiny test-borrow reverts.
    const preExistingDebt = await vBorrow.balanceOf(signer.address);
    if (preExistingDebt > 0n) {
      console.log(`  pre-existing debt found: ${preExistingDebt} vd${borrowSymbol} — repaying max…`);
      // Need approve first (in case the signer's SPL delegate slot was overwritten)
      await (await borrowToken.approve(poolAddr, MaxUint256)).wait();
      try {
        await (await pool.repay(borrow.asset, MaxUint256, RATE_VARIABLE, signer.address)).wait();
        console.log(`    repayed: post-repay vd${borrowSymbol} = ${await vBorrow.balanceOf(signer.address)}`);
      } catch (e) {
        console.log(`    WARN: pre-flight repay failed: ${(e as Error).message}`);
      }
    }

    console.log(`\n--- Phase 1: approve Pool ---`);
    await step(`${collateralSymbol}.approve(pool, max)`, async () => {
      const tx = await collateralToken.approve(poolAddr, MaxUint256);
      await tx.wait();
      return tx.hash;
    });
    await step(`${borrowSymbol}.approve(pool, max)`, async () => {
      const tx = await borrowToken.approve(poolAddr, MaxUint256);
      await tx.wait();
      return tx.hash;
    });

    console.log(`\n--- Phase 2: supply ${collateralSymbol} (collateral) ---`);
    await step(`pool.supply(${collateralSymbol}, ${collateralAmt}, signer, 0)`, async () => {
      const tx = await pool.supply(collateral.asset, collateralAmt, signer.address, 0);
      await tx.wait();
      return tx.hash;
    });
    const aCollBal = await aColl.balanceOf(signer.address);
    console.log(`    a${collateralSymbol} balance: ${aCollBal}`);

    console.log(`\n--- Phase 3: supply ${borrowSymbol} (lender side liquidity) ---`);
    await step(`pool.supply(${borrowSymbol}, ${lendAmt}, signer, 0)`, async () => {
      const tx = await pool.supply(borrow.asset, lendAmt, signer.address, 0);
      await tx.wait();
      return tx.hash;
    });

    console.log(`\n--- Phase 4: enable ${collateralSymbol} as collateral ---`);
    await step(`pool.setUserUseReserveAsCollateral(${collateralSymbol}, true)`, async () => {
      const tx = await pool.setUserUseReserveAsCollateral(collateral.asset, true);
      await tx.wait();
      return tx.hash;
    });

    console.log(`\n--- Phase 5: borrow ${borrowSymbol} (against ${collateralSymbol}) ---`);
    await step(`pool.borrow(${borrowSymbol}, ${borrowAmt}, variable, signer)`, async () => {
      const tx = await pool.borrow(borrow.asset, borrowAmt, RATE_VARIABLE, 0, signer.address);
      await tx.wait();
      return tx.hash;
    });
    const vBorrowBal = await vBorrow.balanceOf(signer.address);
    console.log(`    vd${borrowSymbol} balance: ${vBorrowBal}`);

    console.log(`\n--- Phase 6: repay ${borrowSymbol} (max) ---`);
    await step(`pool.repay(${borrowSymbol}, max, variable, signer)`, async () => {
      const tx = await pool.repay(borrow.asset, MaxUint256, RATE_VARIABLE, signer.address);
      await tx.wait();
      return tx.hash;
    });
    const vBorrowAfter = await vBorrow.balanceOf(signer.address);
    console.log(`    vd${borrowSymbol} balance after: ${vBorrowAfter}`);

    console.log(`\n--- Phase 7: withdraw ${collateralSymbol} (max) ---`);
    await step(`pool.withdraw(${collateralSymbol}, max, signer)`, async () => {
      const tx = await pool.withdraw(collateral.asset, MaxUint256, signer.address);
      await tx.wait();
      return tx.hash;
    });
    const collAfter = await collateralToken.balanceOf(signer.address);
    console.log(`    ${collateralSymbol} balance after: ${collAfter}`);

    // ====================================================================
    // Phase 8: liquidation flow
    //
    // To make a position liquidatable we re-supply collateral + borrow,
    // then crank the debt-asset price UP via a fresh MockAggregator (so
    // user's debt value > liquidation threshold × collateral value).
    // Self-liquidate to exercise the code path.
    // ====================================================================
    console.log(`\n--- Phase 8a: re-establish position (supply + borrow at limit) ---`);
    const liqCollateralAmt = collateralAmt * 2n;
    const liqLendAmt = lendAmt * 200n;
    await step(`pool.supply(${collateralSymbol}, ${liqCollateralAmt}) — re-supply collateral`, async () => {
      const tx = await pool.supply(collateral.asset, liqCollateralAmt, signer.address, 0);
      await tx.wait();
      return tx.hash;
    });
    await step(`pool.supply(${borrowSymbol}, ${liqLendAmt}) — re-supply liquidity`, async () => {
      const tx = await pool.supply(borrow.asset, liqLendAmt, signer.address, 0);
      await tx.wait();
      return tx.hash;
    });
    await step(`pool.setUserUseReserveAsCollateral(${collateralSymbol}, true)`, async () => {
      const tx = await pool.setUserUseReserveAsCollateral(collateral.asset, true);
      await tx.wait();
      return tx.hash;
    });
    // Disable the borrow-asset as collateral for the user. Aave defaults
    // useAsCollateral=true on first supply, so without this the user's
    // supplied wETH (Phase 3 + 8a) counts as collateral — when we crank
    // its price up in Phase 8b, BOTH the debt AND the collateral leg
    // scale together and HF doesn't move. Forcing wETH-not-as-collateral
    // means only wUSDC backs the loan, so crank moves debt only.
    await step(`pool.setUserUseReserveAsCollateral(${borrowSymbol}, false)`, async () => {
      const tx = await pool.setUserUseReserveAsCollateral(borrow.asset, false);
      await tx.wait();
      return tx.hash;
    });

    // Reset borrow-asset price to a known baseline before computing the
    // borrow size. If a prior gamut run cranked the price up (Phase 8b)
    // the AaveOracle source persists, which changes how
    // availableBorrowsBase scales to raw token units. Re-deploying a
    // MockAggregator at the init-reserve price makes this run independent.
    const oracle = await ethers.getContractAt("AaveOracle", deployments.AaveOracle.address);
    const MockAggregator = await ethers.getContractFactory("MockAggregator");
    const baselinePrice = BigInt(Math.round(borrow.priceUsd * 1e8));
    const baselineAgg = await MockAggregator.deploy(baselinePrice);
    await baselineAgg.waitForDeployment();
    const baselineAggAddr = await baselineAgg.getAddress();
    await step(`oracle.setAssetSources(${borrowSymbol}, baseline=${baselinePrice})`, async () => {
      const tx = await oracle.setAssetSources([borrow.asset], [baselineAggAddr]);
      await tx.wait();
      return tx.hash;
    });

    // Borrow near the LTV limit, but at ~80% of theoretical max — Aave's
    // borrow validation uses ceil-rounded debt valuation, so 100% can
    // round just past HF=1.
    const userDataBefore = await pool.getUserAccountData(signer.address);
    const avail = userDataBefore.availableBorrowsBase as bigint;
    console.log(`    availableBorrowsBase (8-dec USD): ${avail}`);
    const borrowPrice = await oracle.getAssetPrice(borrow.asset);
    const borrowDecimals = BigInt(borrow.decimals);
    const liqBorrowAmt = (avail * (10n ** borrowDecimals) * 8n) / (borrowPrice * 10n);
    console.log(`    plan: borrow ${liqBorrowAmt} of ${borrowSymbol} (80% of ${avail} USD-base @ price ${borrowPrice})`);
    if (liqBorrowAmt > 0n) {
      await step(`pool.borrow(${borrowSymbol}, ${liqBorrowAmt}, variable)`, async () => {
        const tx = await pool.borrow(borrow.asset, liqBorrowAmt, RATE_VARIABLE, 0, signer.address);
        await tx.wait();
        return tx.hash;
      });
    }

    console.log(`\n--- Phase 8b: push position underwater via debt-asset price ---`);
    // Crank borrow asset price 10x — multiplies the user's debt value
    // by 10, well past the liquidation threshold. wETH-as-collateral
    // was disabled in 8a, so collateral value stays put.
    const crankedPrice = baselinePrice * 10n;
    const crankedAgg = await MockAggregator.deploy(crankedPrice);
    await crankedAgg.waitForDeployment();
    const crankedAggAddr = await crankedAgg.getAddress();
    console.log(`    new MockAggregator @ ${crankedPrice} (10x baseline ${baselinePrice}): ${crankedAggAddr}`);
    await step(`oracle.setAssetSources(${borrowSymbol}, crankedAgg)`, async () => {
      const tx = await oracle.setAssetSources([borrow.asset], [crankedAggAddr]);
      await tx.wait();
      return tx.hash;
    });

    const userDataAfter = await pool.getUserAccountData(signer.address);
    const hfAfter = userDataAfter.healthFactor as bigint;
    console.log(`    healthFactor after price crank: ${hfAfter} (1e18 = 1.0; <1e18 means liquidatable)`);

    console.log(`\n--- Phase 8c: liquidationCall (two-wallet test) ---`);
    // Aave V3.6 explicitly blocks borrower == liquidator
    // (ValidationLogic line: require(borrower != liquidator, SelfLiquidation()))
    // so we generate a fresh random EOA, fund it with the debt asset + a
    // little native gas, then call liquidationCall from that wallet.
    const vBalForLiq = await vBorrow.balanceOf(signer.address);
    console.log(`    pre-liq vd${borrowSymbol}: ${vBalForLiq}`);
    if (hfAfter < 10n ** 18n) {
      // 1. Generate liquidator wallet
      const liquidator = ethers.Wallet.createRandom().connect(ethers.provider);
      console.log(`    liquidator: ${liquidator.address}`);

      // 2. Fund with native gas — small amount, just enough for ~5 txs
      // Native gas is denominated in wei (18 decimals). Sending 0.01 RSOL =
      // 1e16 wei is plenty for ATA warmup + approve + liquidationCall.
      await step(`fund liquidator with 0.01 native gas`, async () => {
        const tx = await signer.sendTransaction({ to: liquidator.address, value: 10n ** 16n });
        await tx.wait();
        return tx.hash;
      });

      // 3. Fund the liquidator with the debt asset. For cached wrappers,
      // warm the liquidator's ATA first, then transfer. Send half the
      // borrower's debt so liquidator covers ~max-close-factor (50% of debt).
      const debtAmount = (vBalForLiq * 6n) / 10n; // 60% of debt — covers the 50% close-factor cap with margin
      const probeData = "0x5e094743" + signer.address.slice(2).padStart(64, "0");
      let borrowIsCached = false;
      try {
        await ethers.provider.call({ to: borrow.asset, data: probeData });
        borrowIsCached = true;
      } catch {}
      if (borrowIsCached) {
        const wrapper = new ethers.Contract(
          borrow.asset,
          ["function ensure_token_account(address) returns (bytes32)"],
          signer,
        );
        await step(`${borrowSymbol}.ensure_token_account(liquidator)`, async () => {
          const tx = await wrapper.ensure_token_account(liquidator.address);
          await tx.wait();
          return tx.hash;
        });
      }
      await step(`fund liquidator with ${debtAmount} ${borrowSymbol}`, async () => {
        const tx = await borrowToken.transfer(liquidator.address, debtAmount);
        await tx.wait();
        return tx.hash;
      });

      // 4. Liquidator approves Pool for the debt asset
      const borrowTokenAsLiq = borrowToken.connect(liquidator);
      await step(`${borrowSymbol}.approve(pool, max) [liquidator]`, async () => {
        const tx = await (borrowTokenAsLiq as any).approve(poolAddr, MaxUint256);
        await tx.wait();
        return tx.hash;
      });

      // 5. Liquidator calls liquidationCall
      const poolAsLiq = pool.connect(liquidator);
      await step(`pool.liquidationCall(coll=${collateralSymbol}, debt=${borrowSymbol}, borrower=${signer.address.slice(0, 10)}…, debtToCover=${debtAmount})`, async () => {
        const tx = await (poolAsLiq as any).liquidationCall(
          collateral.asset,
          borrow.asset,
          signer.address,
          debtAmount,
          false, // receiveAToken=false → liquidator gets underlying collateral
        );
        await tx.wait();
        return tx.hash;
      });

      const vBalPost = await vBorrow.balanceOf(signer.address);
      const aCollPost = await aColl.balanceOf(signer.address);
      const liqCollPost = await collateralToken.balanceOf(liquidator.address);
      console.log(`    post-liq vd${borrowSymbol}: ${vBalPost} (was ${vBalForLiq})`);
      console.log(`    post-liq a${collateralSymbol} (borrower): ${aCollPost}`);
      console.log(`    post-liq ${collateralSymbol} (liquidator): ${liqCollPost} — should be > 0 (received discounted collateral)`);
    } else {
      console.log(`    SKIP: healthFactor=${hfAfter} >= 1.0; position not liquidatable (price crank may have been too modest)`);
    }

    // ====================================================================
    // Phase 9: flash loan
    // Deploy the SmokeFlashLoanReceiver, fund it with the expected premium
    // (flashLoanPremium bps × loanAmount), then call pool.flashLoanSimple.
    // The Pool transfers the loaned amount to the receiver, calls
    // executeOperation (which approves repayment), and pulls amount+premium
    // back via transferFrom.
    // ====================================================================
    console.log(`\n--- Phase 9: flash loan ---`);
    // Enable flash loans on the borrow reserve — init-reserve defaults this
    // to false. Idempotent (PoolConfigurator allows re-set).
    const configForFlash = await ethers.getContractAt("PoolConfigurator", deployments.PoolConfigurator.address);
    await step(`config.setReserveFlashLoaning(${borrowSymbol}, true)`, async () => {
      const tx = await configForFlash.setReserveFlashLoaning(borrow.asset, true);
      await tx.wait();
      return tx.hash;
    });
    const SmokeReceiver = await ethers.getContractFactory("SmokeFlashLoanReceiver");
    const receiver = await SmokeReceiver.deploy(deployments.PoolAddressesProvider.address);
    await receiver.waitForDeployment();
    const receiverAddr = await receiver.getAddress();
    console.log(`    SmokeFlashLoanReceiver: ${receiverAddr}`);

    // Fund the receiver with the premium (~0.05% of loan by default).
    // Use a small loan amount to keep the premium tiny.
    const flashAmount = 100n;
    const premium = (flashAmount * 5n) / 10000n + 1n; // 0.05% + 1 wei safety
    // For cached wrappers: warm the receiver's ATA first, then transfer the premium in.
    const probeData = "0x5e094743" + signer.address.slice(2).padStart(64, "0");
    let receiverIsCached = false;
    try {
      await ethers.provider.call({ to: borrow.asset, data: probeData });
      receiverIsCached = true;
    } catch {}
    if (receiverIsCached) {
      const wrapper = new ethers.Contract(
        borrow.asset,
        ["function ensure_token_account(address) returns (bytes32)"],
        signer,
      );
      await step(`${borrowSymbol}.ensure_token_account(receiver)`, async () => {
        const tx = await wrapper.ensure_token_account(receiverAddr);
        await tx.wait();
        return tx.hash;
      });
    }
    await step(`fund receiver with premium (${premium} ${borrowSymbol})`, async () => {
      const tx = await borrowToken.transfer(receiverAddr, premium);
      await tx.wait();
      return tx.hash;
    });

    await step(`pool.flashLoanSimple(receiver, ${borrowSymbol}, ${flashAmount}, 0x, 0)`, async () => {
      const tx = await pool.flashLoanSimple(receiverAddr, borrow.asset, flashAmount, "0x", 0);
      await tx.wait();
      return tx.hash;
    });
    const receiverBalPost = await borrowToken.balanceOf(receiverAddr);
    console.log(`    receiver ${borrowSymbol} balance post-flashloan: ${receiverBalPost} (premium retained: 0)`);

    console.log(`\n--- Summary ---`);
    console.log(`  PASS: ${passed.length}`);
    console.log(`  FAIL: ${failed.length}`);
    for (const p of passed) console.log(`    + ${p}`);

    console.log(`\n--- Per-action metrics ---`);
    const txRows = metrics.filter((m) => m.iterSigs !== undefined);
    if (txRows.length > 0) {
      const pad = (s: string, n: number) => s.padEnd(n);
      const padR = (s: string, n: number) => s.padStart(n);
      console.log(
        "  " +
          pad("Action", 65) +
          padR("wall(s)", 9) +
          padR("sigs", 6) +
          padR("Sol CU", 11) +
          padR("max heap", 10) +
          padR("slots", 7),
      );
      console.log("  " + "-".repeat(108));
      for (const m of txRows) {
        const wallS = (m.wallMs / 1000).toFixed(1);
        const cuStr = m.totalCU !== undefined ? m.totalCU.toLocaleString() : "-";
        const heapStr = m.maxHeap !== undefined ? m.maxHeap.toLocaleString() : "-";
        const span = m.slotSpan !== undefined ? String(m.slotSpan) : "-";
        const sigs = m.iterSigs !== undefined ? String(m.iterSigs) : "-";
        const label = m.name.length > 64 ? m.name.slice(0, 62) + "…" : m.name;
        console.log(
          "  " +
            pad(label, 65) +
            padR(wallS, 9) +
            padR(sigs, 6) +
            padR(cuStr, 11) +
            padR(heapStr, 10) +
            padR(span, 7),
        );
      }
    }

    if (failed.length > 0) {
      console.log(`\nFailures:`);
      for (const f of failed) console.log(`  - ${f}`);
      process.exit(1);
    }
  })
  .build();
