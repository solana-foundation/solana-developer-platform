import { afterEach, describe, expect, it } from "vitest";
import {
  clearWalletCache,
  getCachedWallet,
  invalidateCachedWallet,
  setCachedWallet,
} from "./wallet-cache.js";

// Zolana's real Wallet needs a full identity; the cache only compares by
// reference and fingerprint, so any object stands in as a marker.
const fakeWallet = (label: string) =>
  ({ label }) as unknown as Parameters<typeof setCachedWallet>[1];

afterEach(() => clearWalletCache());

describe("wallet-cache", () => {
  it("returns the same wallet instance across get calls", () => {
    const wallet = fakeWallet("first");
    setCachedWallet("hrw_1", wallet, "fp");
    expect(getCachedWallet("hrw_1", "fp")).toBe(wallet);
    expect(getCachedWallet("hrw_1", "fp")).toBe(wallet);
  });

  it("misses when the fingerprint changes", () => {
    setCachedWallet("hrw_1", fakeWallet("first"), "fp-a");
    expect(getCachedWallet("hrw_1", "fp-b")).toBeUndefined();
  });

  it("overwrites on set — later fingerprint wins", () => {
    setCachedWallet("hrw_1", fakeWallet("first"), "fp-a");
    const second = fakeWallet("second");
    setCachedWallet("hrw_1", second, "fp-b");
    expect(getCachedWallet("hrw_1", "fp-b")).toBe(second);
    expect(getCachedWallet("hrw_1", "fp-a")).toBeUndefined();
  });

  it("drops the entry on invalidate", () => {
    setCachedWallet("hrw_1", fakeWallet("first"), "fp");
    invalidateCachedWallet("hrw_1");
    expect(getCachedWallet("hrw_1", "fp")).toBeUndefined();
  });

  it("keeps entries isolated per walletId", () => {
    const a = fakeWallet("a");
    const b = fakeWallet("b");
    setCachedWallet("hrw_1", a, "fp");
    setCachedWallet("hrw_2", b, "fp");
    expect(getCachedWallet("hrw_1", "fp")).toBe(a);
    expect(getCachedWallet("hrw_2", "fp")).toBe(b);
  });
});
