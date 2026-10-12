import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWalletBalance, fetchWalletBalances } from "./wallet-balances.data";

vi.mock("@/lib/dashboard-fetch", () => ({
  dashboardRequest: (...args: Parameters<typeof fetch>) => fetch(...args),
}));
afterEach(() => vi.unstubAllGlobals());

describe("exact wallet balance reads", () => {
  it("rejects a successful response that identifies another wallet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: {
              custodyWalletId: "wallet-b",
              walletId: "provider-shared",
              address: "address",
              balances: [],
            },
          },
        })
      )
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([403, 404, 503])("does not interpret HTTP %s as zero", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}, { status }))
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it.each([
    { custodyWalletId: undefined, address: "address", balances: [] },
    { custodyWalletId: "wallet-a", address: "address", balances: [{}] },
    { custodyWalletId: "wallet-a", address: "address", balances: "0" },
  ])("rejects missing identity and malformed balances", async (walletBalances) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: { walletBalances } }))
    );
    await expect(fetchWalletBalance("wallet-a")).rejects.toThrow();
  });
  it("preserves a successful zero balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            walletBalances: {
              custodyWalletId: "wallet-a",
              walletId: "provider",
              address: "address",
              balances: [],
            },
          },
        })
      )
    );
    expect(await fetchWalletBalance("wallet-a")).toEqual([]);
  });

  it("keeps aliases with the same provider reference separate in batch results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            wallets: [
              { id: "wallet-a", walletId: "shared-provider", balances: [] },
              { id: "wallet-b", walletId: "shared-provider", balances: [] },
              { id: "unavailable" },
            ],
          },
        })
      )
    );
    expect(await fetchWalletBalances()).toEqual({ "wallet-a": [], "wallet-b": [] });
  });
});
