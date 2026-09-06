import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EarnFundingWallet,
  fetchFundingWallets,
  fetchLiveFundingWalletBalance,
  refreshFundingWalletBalances,
} from "./earn-funding-wallets";

afterEach(() => {
  vi.unstubAllGlobals();
});

function wallet(overrides: Partial<EarnFundingWallet> & { id: string }): EarnFundingWallet {
  return {
    walletId: `provider-${overrides.id}`,
    publicKey: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    label: null,
    purpose: null,
    status: "active",
    isRuntimeExecutionAllowed: true,
    ...overrides,
  };
}

function stubResponse(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body))
  );
}

describe("fetchFundingWallets", () => {
  it("fails closed when a successful response omits the wallet collection", async () => {
    stubResponse({ data: {} });
    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("fails closed on a row missing the address a deposit is signed from", async () => {
    // The cast this replaced let such a row through as a complete wallet.
    const { publicKey: _omitted, ...incomplete } = wallet({ id: "active" });
    stubResponse({ data: { wallets: [incomplete] } });
    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("returns only active wallets from the live response", async () => {
    const active = wallet({ id: "active" });
    stubResponse({
      data: { wallets: [active, wallet({ id: "inactive", status: "inactive" })] },
    });

    await expect(fetchFundingWallets()).resolves.toEqual([active]);
  });
});

describe("live funding wallet balances", () => {
  it("bypasses the cached collection and reads the wallet balance endpoint", async () => {
    const balances = [
      {
        token: "USDC",
        mint: "USDC111111111111111111111111111111111111111",
        amount: "425000000",
        uiAmount: "425",
        decimals: 6,
      },
    ];
    const fetchMock = vi.fn(async () => Response.json({ data: { walletBalances: { balances } } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLiveFundingWalletBalance("wallet/live")).resolves.toEqual(balances);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/payments/wallets/wallet%2Flive/balances",
      { cache: "no-store" }
    );
  });

  it("updates healthy wallets while preserving an unavailable wallet observation", async () => {
    const first = wallet({
      id: "first",
      balances: [
        {
          token: "USDC",
          mint: "USDC111111111111111111111111111111111111111",
          amount: "1000000",
          uiAmount: "1",
          decimals: 6,
        },
      ],
    });
    const unavailable = wallet({ id: "unavailable", balances: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("provider-unavailable")) {
          return Response.json({ error: { message: "RPC unavailable" } }, { status: 503 });
        }
        return Response.json({
          data: {
            walletBalances: {
              balances: [
                {
                  token: "USDC",
                  mint: "USDC111111111111111111111111111111111111111",
                  amount: "500000",
                  uiAmount: "0.5",
                  decimals: 6,
                },
              ],
            },
          },
        });
      })
    );

    const refreshed = await refreshFundingWalletBalances([first, unavailable]);
    expect(refreshed[0]?.balances?.[0]?.uiAmount).toBe("0.5");
    expect(refreshed[1]).toBe(unavailable);
    expect(refreshed[1]?.balances).toBeUndefined();
  });
});
