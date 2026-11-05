// Shared helpers for the wBTC listing scripts (set-reserve-caps, wbtc-four-collateral-measure).
import { ethers } from "ethers";
import { loadDeployments, loadShims } from "./oracle-common.js";

export const env = (k: string, d = "") => process.env[k] || d;
export const RPC_URL = () => env("RPC_URL", "https://hadrian.testnet.romeprotocol.xyz/");

export const DATA_PROVIDER_ABI = [
  "function getReserveCaps(address) view returns (uint256 borrowCap, uint256 supplyCap)",
  "function getReserveConfigurationData(address) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
];

/** Symbol (wUSDC, wETH, wSOL, wBTC) or 0x address -> { symbol, address }. wBTC resolves from the shims record until it is listed. */
export function resolveAsset(input: string, net = "hadrian"): { symbol: string; address: string } {
  if (ethers.isAddress(input)) return { symbol: input, address: ethers.getAddress(input) };
  const dep = loadDeployments(net);
  const fromReserves = dep._reserves?.[input]?.asset;
  const fromShims = (() => { try { return loadShims(net)[input]?.asset; } catch { return undefined; } })();
  const a = fromReserves ?? fromShims;
  if (!a) throw new Error(`unknown asset ${input}: not an address, not in deployments/${net}.json _reserves, not in the shims record`);
  return { symbol: input, address: ethers.getAddress(a) };
}

/** Decimal string -> base units using the token's own decimals(). */
export async function toUnits(provider: ethers.Provider, token: string, human: string): Promise<bigint> {
  const d = Number(await new ethers.Contract(token, ["function decimals() view returns (uint8)"], provider).decimals());
  return ethers.parseUnits(human, d);
}

const SDK_ACCOUNTS_RE = /Too many accounts: (\d+), maximum allowed is (\d+)/;

/**
 * Read-only preflight of one admin transaction: eth_call AND eth_estimateGas from `from`.
 * eth_call does NOT apply the proxy's account limit; eth_estimateGas does ("Too many accounts: N, maximum
 * allowed is M", the Rome-EVM SDK count). A call that passes eth_call but fails estimateGas cannot be sent.
 */
export async function preflight(provider: ethers.Provider, tx: { from: string; to: string; data: string }): Promise<{ ok: boolean; text: string }> {
  const parts: string[] = [];
  let ok = true;
  try { await provider.call(tx); parts.push("eth_call ok"); }
  catch (e: any) { ok = false; parts.push(`eth_call REVERTS (${e.shortMessage ?? e.message})`); }
  try { parts.push(`estimateGas ${(await provider.estimateGas(tx)).toString()}`); }
  catch (e: any) {
    ok = false;
    const msg = String(e.info?.error?.message ?? e.shortMessage ?? e.message ?? e);
    const m = SDK_ACCOUNTS_RE.exec(msg);
    parts.push(m ? `estimateGas FAILS: SDK account count ${m[1]}/${m[2]} (cannot be sent)` : `estimateGas FAILS (${msg.slice(0, 100)})`);
  }
  return { ok, text: parts.join("; ") };
}
