import type { TokenStatus } from "@sdp/types";
import { describe, expect, it } from "vitest";
import type { ComboboxOption } from "@/components/ui/combobox";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import {
  eligibleRecurringPaymentAssets,
  fallbackRecurringPaymentToken,
} from "./recurring-payment-assets";

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const EURC = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const ISSUED_MINT = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function option(value: string): ComboboxOption {
  return { value, label: value };
}

function issuedToken(status?: TokenStatus): Record<string, PaymentsIssuedTokenSymbol> {
  return {
    [ISSUED_MINT]: {
      id: "tok_issued",
      mintAddress: ISSUED_MINT,
      symbol: "ITT",
      imageUrl: null,
      ...(status === undefined ? {} : { status }),
    },
  };
}

describe("eligibleRecurringPaymentAssets", () => {
  it("offers USD stablecoins on the active cluster only", () => {
    const options = [DEVNET_USDC, MAINNET_USDC, EURC].map(option);

    expect(eligibleRecurringPaymentAssets(options, {}, "sandbox")).toEqual([option(DEVNET_USDC)]);
    expect(eligibleRecurringPaymentAssets(options, {}, "production")).toEqual([
      option(MAINNET_USDC),
    ]);
  });

  it("offers an issued token only while it is active", () => {
    const options = [option(ISSUED_MINT)];

    expect(eligibleRecurringPaymentAssets(options, issuedToken("active"), "sandbox")).toEqual(
      options
    );
    for (const status of ["pending", "paused", "revoked", undefined] as const) {
      expect(eligibleRecurringPaymentAssets(options, issuedToken(status), "sandbox")).toEqual([]);
    }
  });
});

describe("fallbackRecurringPaymentToken", () => {
  const eligible = [option(DEVNET_USDC), option(ISSUED_MINT)];

  it("keeps a token that is still offered", () => {
    expect(fallbackRecurringPaymentToken(ISSUED_MINT, eligible)).toBe(ISSUED_MINT);
  });

  it("falls back to the first offered token", () => {
    expect(fallbackRecurringPaymentToken(MAINNET_USDC, eligible)).toBe(DEVNET_USDC);
  });

  it("clears the token when nothing is offered", () => {
    expect(fallbackRecurringPaymentToken(DEVNET_USDC, [])).toBe("");
  });
});
