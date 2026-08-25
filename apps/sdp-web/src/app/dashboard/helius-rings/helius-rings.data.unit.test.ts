import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncRingsWallet } from "./helius-rings.data";

const syncResult = {
  balances: [
    {
      mint: "mint_usdc",
      symbol: "USDC",
      amountRaw: "1250000",
      decimals: 6,
    },
  ],
  history: [
    {
      signature: "signature_1",
      slot: "123",
      index: "0",
      kind: "shield",
      direction: "inbound",
      mint: "mint_usdc",
      amountRaw: "1250000",
    },
  ],
  report: {
    storedNotes: 1,
    unparsedTransactions: 0,
    undecryptableCandidates: 0,
    unknownAssetIds: 0,
    unknownAssetFields: 0,
    degraded: false,
  },
  indexedOperationSignatures: ["signature_1"],
  observedAt: "2026-08-25T17:00:00.000Z",
  observedSlot: "123",
} as const;

describe("syncRingsWallet", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the encoded wallet BFF route and returns the sync result", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: syncResult }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(syncRingsWallet("wallet/with space", "Fallback error")).resolves.toEqual({
      result: syncResult,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/helius-rings/wallets/wallet%2Fwith%20space/sync",
      {
        method: "POST",
        cache: "no-store",
      }
    );
  });

  it("preserves the API error message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Photon has not caught up yet." } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(syncRingsWallet("wallet_1", "Fallback error")).resolves.toEqual({
      error: "Photon has not caught up yet.",
    });
  });

  it("returns the localized fallback for network and malformed-response failures", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(syncRingsWallet("wallet_1", "Localized fallback")).resolves.toEqual({
      error: "Localized fallback",
    });

    fetchMock.mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(syncRingsWallet("wallet_1", "Localized fallback")).resolves.toEqual({
      error: "Localized fallback",
    });
  });
});
