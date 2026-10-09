import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWindowPathname } from "@/test/window-location";
import {
  type EarnFundingWallet,
  fetchFundingWallets,
  fetchLiveFundingWalletBalance,
  refreshFundingWalletBalances,
} from "./earn-funding-wallets";

const PROJECT_HEADERS = new Headers({ "x-project-id": "prj_test_sandbox" });

beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/markets/treasury-solutions"));
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
  const { publicKey: _omitted, ...incomplete } = wallet({ id: "active" });
  it.each([
    ["omits the wallet collection", { data: {} }],
    ["has a row missing the address a deposit is signed from", { data: { wallets: [incomplete] } }],
  ])("fails closed when a successful response %s", async (_condition, body) => {
    stubResponse(body);
    await expect(fetchFundingWallets()).rejects.toThrow("Invalid custody wallet response");
  });

  it("returns only active wallets from the live response", async () => {
    const active = wallet({ id: "active" });
    stubResponse({
      data: { wallets: [active, wallet({ id: "inactive", status: "inactive" })] },
    });

    await expect(fetchFundingWallets()).resolves.toEqual([active]);
  });

  it("keeps same-address Connection owners and runtime-disabled wallets in inventory", async () => {
    const wallets = [
      { ...wallet({ id: "wallet-a" }), custodyConnectionId: "connection-a" },
      {
        ...wallet({ id: "wallet-b", isRuntimeExecutionAllowed: false }),
        custodyConnectionId: "connection-b",
      },
      { ...wallet({ id: "wallet-c" }), custodyConfigId: "config-c" },
    ];
    stubResponse({ data: { wallets } });

    await expect(fetchFundingWallets()).resolves.toEqual(wallets);
    expect(fetch).toHaveBeenCalledWith(
      "/api/dashboard/wallets?view=summary&includeBalances=true&includeAllProviders=true",
      { headers: PROJECT_HEADERS }
    );
  });
});

describe("live funding wallet balances", () => {
  it("constrains only affected wallets and other bindings of the same chain address", async () => {
    const affected = wallet({ id: "affected" });
    const alias = wallet({ id: "alias" });
    const unrelated = wallet({ id: "unrelated", publicKey: "11111111111111111111111111111111" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        data: { balanceReadContext: { minimumSlot: 101 }, walletBalances: { balances: [] } },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await refreshFundingWalletBalances([affected, alias, unrelated], new Map([[affected.id, 101]]));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/dashboard/payments/wallets/affected/balances?minimumSlot=101",
      "/api/dashboard/payments/wallets/alias/balances?minimumSlot=101",
      "/api/dashboard/payments/wallets/unrelated/balances",
    ]);
  });
  it("requires the wallet API to acknowledge the position confirmation slot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { walletBalances: { balances: [] } } }))
      .mockResolvedValueOnce(
        Response.json({
          data: { balanceReadContext: { minimumSlot: 100 }, walletBalances: { balances: [] } },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: { balanceReadContext: { minimumSlot: 101 }, walletBalances: { balances: [] } },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLiveFundingWalletBalance("wallet", 101)).rejects.toThrow(
      "confirmation freshness"
    );
    await expect(fetchLiveFundingWalletBalance("wallet", 101)).rejects.toThrow(
      "confirmation freshness"
    );
    await expect(fetchLiveFundingWalletBalance("wallet", 101)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/dashboard/payments/wallets/wallet/balances?minimumSlot=101",
      { cache: "no-store", headers: PROJECT_HEADERS }
    );
  });

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
      { cache: "no-store", headers: PROJECT_HEADERS }
    );
  });

  it("rejects a partial refresh instead of returning a cached balance as fresh", async () => {
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
    const unavailable = wallet({ id: "unavailable", balances: first.balances });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/wallets/unavailable/")) {
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

    await expect(refreshFundingWalletBalances([first, unavailable])).rejects.toThrow(
      "Request failed (503)"
    );
    expect(first.balances?.[0]?.uiAmount).toBe("1");
    expect(unavailable.balances?.[0]?.uiAmount).toBe("1");
  });
});
