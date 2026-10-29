import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { resolveDepositSwapRequest } from "./shared";

/**
 * The swap-funding normalization both deposit surfaces share: cluster-pinned
 * mint membership, the same-mint no-op, and the orphaned-tolerance refusal.
 */

const DEVNET_USDC = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
const DEVNET_USDG = WELL_KNOWN_TOKENS.USDG.mints.devnet.address;
const MAINNET_USDT = WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address;
const DEPOSIT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** The check as a request for `environment` runs it: inside that environment's cluster scope. */
function swapRequestIn(
  environment: SdpEnvironment,
  body: Parameters<typeof resolveDepositSwapRequest>[0]
) {
  return runInClusterScope({ projectId: null, environment }, () =>
    resolveDepositSwapRequest(body, DEPOSIT_MINT)
  );
}

describe("resolveDepositSwapRequest", () => {
  it("answers null when no source token is named", () => {
    expect(swapRequestIn("sandbox", {})).toBeNull();
  });

  it("refuses a swap tolerance without a swap, rather than silently ignoring it", () => {
    expect(() => swapRequestIn("sandbox", { swapSlippageBps: 50 })).toThrowError(
      /requires sourceTokenMint/
    );
  });

  it("treats a source equal to the vault's own deposit mint as a no-op", () => {
    expect(
      swapRequestIn("sandbox", { sourceTokenMint: DEPOSIT_MINT, swapSlippageBps: 75 })
    ).toBeNull();
  });

  it("accepts a supported mint on the scope's cluster and defaults the tolerance", () => {
    expect(swapRequestIn("sandbox", { sourceTokenMint: DEVNET_USDG })).toEqual({
      sourceTokenMint: DEVNET_USDG,
      slippageBps: 2,
    });
    expect(
      swapRequestIn("sandbox", { sourceTokenMint: DEVNET_USDC, swapSlippageBps: 100 })
    ).toEqual({ sourceTokenMint: DEVNET_USDC, slippageBps: 100 });
  });

  it("refuses a mint from the WRONG cluster: USDT exists on mainnet only", () => {
    // Sandbox is devnet, where USDT has no deployment — the mainnet address
    // must not pass just because the symbol is supported somewhere.
    expect(() => swapRequestIn("sandbox", { sourceTokenMint: MAINNET_USDT })).toThrowError(
      /not a supported swap funding token on devnet/
    );
    // The same address is legal in production, whose cluster carries it.
    expect(swapRequestIn("production", { sourceTokenMint: MAINNET_USDT })).toEqual({
      sourceTokenMint: MAINNET_USDT,
      slippageBps: 2,
    });
  });

  it("refuses an arbitrary mint outside the pinned set", () => {
    expect(() =>
      swapRequestIn("sandbox", { sourceTokenMint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" })
    ).toThrowError(/not a supported swap funding token/);
  });
});
