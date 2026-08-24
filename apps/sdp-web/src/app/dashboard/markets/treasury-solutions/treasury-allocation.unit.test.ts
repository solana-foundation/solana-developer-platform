import { SOL_MINT, type WellKnownTokenSymbol, wellKnownMint } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  formatAllocationShare,
  summarizeTreasuryAllocation,
  type TreasuryAllocationPosition,
  type TreasuryAllocationWallet,
} from "./treasury-allocation";

function requiredMint(symbol: WellKnownTokenSymbol): string {
  const mint = wellKnownMint(symbol, "mainnet-beta");
  if (!mint) throw new Error(`Missing mainnet mint for ${symbol}`);
  return mint;
}

const USDC_MINT = requiredMint("USDC");
const USDG_MINT = requiredMint("USDG");
const UNKNOWN_MINT = "Unknown11111111111111111111111111111111111";

function wallet(
  balances: { mint: string; uiAmount: string }[] | undefined,
  id = "wallet-a"
): TreasuryAllocationWallet {
  return { id, balances };
}

function openPosition(overrides: Partial<TreasuryAllocationPosition>): TreasuryAllocationPosition {
  return {
    closedAt: null,
    custodyWalletId: "wallet-a",
    shares: "10",
    tokenMint: USDC_MINT,
    tokenValue: "1",
    ...overrides,
  };
}

describe("summarizeTreasuryAllocation", () => {
  it("totals multi-wallet cash and multi-position value into shares summing to exactly 100%", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [
        wallet([
          { mint: USDC_MINT, uiAmount: "1200.50" },
          // A SOL gas balance is not treasury cash.
          { mint: SOL_MINT, uiAmount: "3.5" },
        ]),
        wallet(
          [
            { mint: USDG_MINT, uiAmount: "800" },
            // Neither is a token the catalogue cannot price at $1.
            { mint: UNKNOWN_MINT, uiAmount: "42" },
          ],
          "wallet-b"
        ),
      ],
      positions: [
        openPosition({ tokenValue: "999.5" }),
        openPosition({ custodyWalletId: "wallet-b", tokenMint: USDG_MINT, tokenValue: "3000" }),
        // Zero shares and closed positions are not part of the rendered set.
        openPosition({ shares: "0", tokenValue: "77" }),
        openPosition({ closedAt: "2026-08-20T00:00:00.000Z", tokenValue: "88" }),
      ],
    });

    expect(summary.availableCash).toBe("2000.5");
    expect(summary.deployedValue).toBe("3999.5");
    expect(summary.deployedShare).toBe("0.667");
    expect(summary.remainingShare).toBe("0.333");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("66.7%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("33.3%");
  });

  it("makes cash unavailable when any wallet balance cannot be read, never zero", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }]), wallet(undefined, "wallet-b")],
      positions: [openPosition({ tokenValue: "125.25" })],
    });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBe("125.25");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("—");
  });

  it("makes cash unavailable when a stable balance is malformed", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "12,5" }])],
      positions: [],
    });

    expect(summary.availableCash).toBeUndefined();
  });

  it("makes deployed unavailable when any open position cannot be hydrated, never zero", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: undefined }), openPosition({ tokenValue: "40" })],
    });

    expect(summary.availableCash).toBe("500");
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("makes deployed unavailable when an open position value is malformed", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [openPosition({ tokenValue: "12,5" })],
    });

    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("makes deployed unavailable rather than pricing a non-USD-stable position at $1", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([])],
      positions: [openPosition({ tokenMint: SOL_MINT, tokenValue: "10" })],
    });

    expect(summary.deployedValue).toBeUndefined();
  });

  it("withholds shares when an open position's custody wallet is not in the wallet read", () => {
    // The wallet read serves active wallets only, so this position's idle-cash
    // side is unobserved: both dollar figures still render, but a percentage
    // split would be fabricated.
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "50" }])],
      positions: [openPosition({ custodyWalletId: "wallet-deactivated", tokenValue: "100" })],
    });

    expect(summary.availableCash).toBe("50");
    expect(summary.deployedValue).toBe("100");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("propagates failed reads as unavailable on both sides", () => {
    const summary = summarizeTreasuryAllocation({ wallets: undefined, positions: undefined });

    expect(summary.availableCash).toBeUndefined();
    expect(summary.deployedValue).toBeUndefined();
    expect(summary.deployedShare).toBeUndefined();
  });

  it("reports real zeros for a readable empty treasury without inventing an allocation", () => {
    const summary = summarizeTreasuryAllocation({ wallets: [wallet([])], positions: [] });

    expect(summary.availableCash).toBe("0");
    expect(summary.deployedValue).toBe("0");
    expect(summary.deployedShare).toBeUndefined();
    expect(summary.remainingShare).toBeUndefined();
  });

  it("reads a fully idle float as 0% deployed and 100% remaining", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "500" }])],
      positions: [],
    });

    expect(summary.deployedShare).toBe("0");
    expect(summary.remainingShare).toBe("1");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("0.0%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("100.0%");
  });

  it("reads a fully deployed float as 100% deployed", () => {
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([])],
      positions: [openPosition({ tokenValue: "800" })],
    });

    expect(summary.deployedShare).toBe("1");
    expect(summary.remainingShare).toBe("0");
  });

  it("rounds half-up to tenths of a percent and keeps the complement exact", () => {
    // 1 of 2000 is exactly 0.05%, which rounds up to 0.1%; the remaining
    // share is the complement so the pair still totals exactly 100%.
    const summary = summarizeTreasuryAllocation({
      wallets: [wallet([{ mint: USDC_MINT, uiAmount: "1999" }])],
      positions: [openPosition({ tokenValue: "1" })],
    });

    expect(summary.deployedShare).toBe("0.001");
    expect(summary.remainingShare).toBe("0.999");
    expect(formatAllocationShare(summary.deployedShare, "en")).toBe("0.1%");
    expect(formatAllocationShare(summary.remainingShare, "en")).toBe("99.9%");
  });
});
