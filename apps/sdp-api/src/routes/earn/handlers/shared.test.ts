import { WELL_KNOWN_TOKENS } from "@sdp/types";
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

describe("resolveDepositSwapRequest", () => {
  it("answers null when no source token is named", () => {
    expect(resolveDepositSwapRequest({}, "sandbox", DEPOSIT_MINT)).toBeNull();
  });

  it("refuses a swap tolerance without a swap, rather than silently ignoring it", () => {
    expect(() =>
      resolveDepositSwapRequest({ swapSlippageBps: 50 }, "sandbox", DEPOSIT_MINT)
    ).toThrowError(/requires sourceTokenMint/);
  });

  it("treats a source equal to the vault's own deposit mint as a no-op", () => {
    expect(
      resolveDepositSwapRequest(
        { sourceTokenMint: DEPOSIT_MINT, swapSlippageBps: 75 },
        "sandbox",
        DEPOSIT_MINT
      )
    ).toBeNull();
  });

  it("accepts a supported mint on the environment's cluster and defaults the tolerance", () => {
    expect(
      resolveDepositSwapRequest({ sourceTokenMint: DEVNET_USDG }, "sandbox", DEPOSIT_MINT)
    ).toEqual({ sourceTokenMint: DEVNET_USDG, slippageBps: 2 });
    expect(
      resolveDepositSwapRequest(
        { sourceTokenMint: DEVNET_USDC, swapSlippageBps: 100 },
        "sandbox",
        DEPOSIT_MINT
      )
    ).toEqual({ sourceTokenMint: DEVNET_USDC, slippageBps: 100 });
  });

  it("refuses a mint from the WRONG cluster: USDT exists on mainnet only", () => {
    // Sandbox is devnet, where USDT has no deployment — the mainnet address
    // must not pass just because the symbol is supported somewhere.
    expect(() =>
      resolveDepositSwapRequest({ sourceTokenMint: MAINNET_USDT }, "sandbox", DEPOSIT_MINT)
    ).toThrowError(/not a supported swap funding token on devnet/);
    // The same address is legal in production, whose cluster carries it.
    expect(
      resolveDepositSwapRequest({ sourceTokenMint: MAINNET_USDT }, "production", DEPOSIT_MINT)
    ).toEqual({ sourceTokenMint: MAINNET_USDT, slippageBps: 2 });
  });

  it("refuses an arbitrary mint outside the pinned set", () => {
    expect(() =>
      resolveDepositSwapRequest(
        { sourceTokenMint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
        "sandbox",
        DEPOSIT_MINT
      )
    ).toThrowError(/not a supported swap funding token/);
  });
});
