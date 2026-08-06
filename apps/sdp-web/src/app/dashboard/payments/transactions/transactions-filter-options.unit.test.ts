import { describe, expect, it, vi } from "vitest";
import { assetFilterOptions, fetchTransactionFilterOptions } from "./transactions-filter-options";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("transaction filter options", () => {
  it("loads every counterparty page while the unpaginated wallet endpoint returns all wallets", async () => {
    const counterparties = Array.from({ length: 125 }, (_, index) => ({
      id: `counterparty-${index + 1}`,
      displayName: `Counterparty ${index + 1}`,
    }));
    const request = vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/wallets")) {
        return jsonResponse({
          data: {
            wallets: [
              { walletId: "wallet-1", publicKey: "public-key-1", label: "Treasury" },
              { walletId: "wallet-2", publicKey: "public-key-2", label: null },
            ],
          },
        });
      }

      const page = Number(url.searchParams.get("page"));
      const pageSize = 100;
      const start = (page - 1) * pageSize;
      return jsonResponse({
        data: {
          counterparties: counterparties.slice(start, start + pageSize),
          total: counterparties.length,
          page,
          pageSize,
        },
      });
    });

    const options = await fetchTransactionFilterOptions(request);

    expect(options.wallets).toEqual([
      { id: "wallet-1", label: "Treasury" },
      { id: "wallet-2", label: "public-key-2" },
    ]);
    expect(options.counterparties).toHaveLength(125);
    expect(options.counterparties.at(-1)).toEqual({
      id: "counterparty-125",
      label: "Counterparty 125",
    });
    expect(request).toHaveBeenCalledWith("/api/dashboard/wallets?view=summary", {
      cache: "no-store",
    });
    expect(request).toHaveBeenCalledWith("/api/dashboard/counterparty?page=2&pageSize=100", {
      cache: "no-store",
    });
  });
});

describe("asset options", () => {
  function request(aggregate: unknown) {
    return vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/wallets/aggregate")) {
        return jsonResponse(aggregate);
      }
      if (url.pathname.endsWith("/wallets")) {
        return jsonResponse({ data: { wallets: [] } });
      }
      return jsonResponse({ data: { counterparties: [], pagination: { totalPages: 1 } } });
    });
  }

  it("resolves a symbol even when the aggregate repeats the mint in `token`", async () => {
    // This is what the API actually sends for well-known tokens: `token` carries
    // the mint, not a symbol. An earlier version read that field directly and put
    // a 44-character address in the filter.
    const options = await fetchTransactionFilterOptions(
      request({
        data: {
          aggregate: {
            balances: [
              {
                mint: "So11111111111111111111111111111111111111112",
                token: "So11111111111111111111111111111111111111112",
              },
              {
                mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              },
            ],
          },
        },
      })
    );

    expect(options.assets).toEqual([
      { id: "So11111111111111111111111111111111111111112", label: "SOL" },
      { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC" },
    ]);
  });

  it("keys by mint while labelling with a symbol the aggregate did supply", async () => {
    const options = await fetchTransactionFilterOptions(
      request({ data: { aggregate: { balances: [{ mint: "mint-issued", token: "ATD" }] } } })
    );

    expect(options.assets).toEqual([{ id: "mint-issued", label: "ATD" }]);
  });

  it("does not repeat a mint held across several wallets", async () => {
    const options = await fetchTransactionFilterOptions(
      request({
        data: {
          aggregate: {
            balances: [
              { mint: "mint-a", token: "AAA" },
              { mint: "mint-a", token: "AAA" },
            ],
          },
        },
      })
    );

    expect(options.assets).toHaveLength(1);
  });

  it("shortens an unknown mint rather than printing all 44 characters", async () => {
    const options = await fetchTransactionFilterOptions(
      request({
        data: {
          aggregate: {
            balances: [{ mint: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", token: "" }],
          },
        },
      })
    );

    expect(options.assets).toHaveLength(1);
    expect(options.assets[0].id).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(options.assets[0].label.length).toBeLessThan(20);
  });

  it("leaves the filter usable when the aggregate fails", async () => {
    const failing = vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/wallets/aggregate")) {
        return new Response("nope", { status: 500 });
      }
      if (url.pathname.endsWith("/wallets")) {
        return jsonResponse({ data: { wallets: [] } });
      }
      return jsonResponse({ data: { counterparties: [], pagination: { totalPages: 1 } } });
    });

    const options = await fetchTransactionFilterOptions(failing);
    expect(options.assets).toEqual([]);
  });

  it("keeps the other filters when the aggregate request rejects outright", async () => {
    // A 500 still resolves, so the `.ok` check catches it. A transport-level
    // rejection does not, and sharing one Promise.all meant it took the wallet
    // and counterparty selects down with it — the whole bar rendered empty.
    const rejecting = vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/wallets/aggregate")) {
        throw new TypeError("Failed to fetch");
      }
      if (url.pathname.endsWith("/wallets")) {
        return jsonResponse({
          data: { wallets: [{ walletId: "wallet-1", publicKey: "pk-1", label: "Treasury" }] },
        });
      }
      return jsonResponse({
        data: {
          counterparties: [{ id: "cp-1", displayName: "Acme" }],
          pagination: { totalPages: 1 },
        },
      });
    });

    const options = await fetchTransactionFilterOptions(rejecting);

    expect(options.assets).toEqual([]);
    expect(options.wallets).toEqual([{ id: "wallet-1", label: "Treasury" }]);
    expect(options.counterparties).toEqual([{ id: "cp-1", label: "Acme" }]);
  });
});

describe("the currently filtered asset", () => {
  const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  it("names a deep-linked mint while the options are still loading", () => {
    // Clicking a holding on the home page lands here with the mint already in the
    // URL, and these options arrive later over SWR. Labelling the value with
    // itself put the 44-character address back on screen for that whole window.
    const assets = assetFilterOptions(USDC_DEVNET, []);

    expect(assets).toHaveLength(1);
    expect(assets[0].id).toBe(USDC_DEVNET);
    expect(assets[0].label).toBe("USDC");
    expect(assets[0].label).not.toBe(USDC_DEVNET);
  });

  it("shortens a mint the catalogue cannot name rather than printing all 44", () => {
    const unknown = "MintNobodyHasEverIssued1111111111111111111111";

    const [asset] = assetFilterOptions(unknown, []);

    expect(asset.id).toBe(unknown);
    expect(asset.label).not.toBe(unknown);
    expect(asset.label.length).toBeLessThan(unknown.length);
  });

  it("prefers the option the aggregate already resolved", () => {
    const assets = assetFilterOptions(USDC_DEVNET, [{ id: USDC_DEVNET, label: "USDC" }]);

    expect(assets).toHaveLength(1);
    expect(assets[0].label).toBe("USDC");
  });

  it("leaves the options untouched when nothing is filtered", () => {
    const options = [{ id: USDC_DEVNET, label: "USDC" }];

    expect(assetFilterOptions(undefined, options)).toEqual(options);
  });
});

describe("assets an organization can filter by", () => {
  const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  function respond(handlers: {
    balances?: Array<{ mint: string; token: string }>;
    transfers?: Array<{ token: string }>;
  }) {
    return vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/wallets/aggregate")) {
        return jsonResponse({ data: { aggregate: { balances: handlers.balances ?? [] } } });
      }
      if (url.pathname.endsWith("/payments/transfers")) {
        return jsonResponse({ data: handlers.transfers ?? [] });
      }
      if (url.pathname.endsWith("/wallets")) {
        return jsonResponse({ data: { wallets: [] } });
      }
      return jsonResponse({ data: { counterparties: [], pagination: { totalPages: 1 } } });
    });
  }

  it("offers a token the organization transferred away and no longer holds", async () => {
    // The whole balance went out, so the aggregate reports nothing — but those
    // transfers are still the rows this filter exists to narrow. Sourcing options
    // from balances alone left the select empty on a table full of SOL.
    const options = await fetchTransactionFilterOptions(
      respond({ balances: [], transfers: [{ token: SOL_MINT }, { token: "SOL" }] })
    );

    expect(options.assets).toHaveLength(1);
    expect(options.assets[0].label).toBe("SOL");
  });

  it("does not list the same asset twice when it is stored both ways", async () => {
    // pt.token holds a mint on some rows and a bare symbol on others.
    const options = await fetchTransactionFilterOptions(
      respond({
        balances: [{ mint: SOL_MINT, token: SOL_MINT }],
        transfers: [{ token: "SOL" }, { token: SOL_MINT }],
      })
    );

    expect(options.assets).toHaveLength(1);
    expect(options.assets[0].id).toBe(SOL_MINT);
  });

  it("keeps held and transacted assets together", async () => {
    const options = await fetchTransactionFilterOptions(
      respond({
        balances: [{ mint: USDC_DEVNET, token: USDC_DEVNET }],
        transfers: [{ token: SOL_MINT }],
      })
    );

    expect(options.assets.map((asset) => asset.label).sort()).toEqual(["SOL", "USDC"]);
  });

  it("still lists held assets when the transfer sample fails", async () => {
    const failing = vi.fn(async (input: string) => {
      const url = new URL(input, "http://dashboard.local");
      if (url.pathname.endsWith("/payments/transfers")) throw new TypeError("Failed to fetch");
      if (url.pathname.endsWith("/wallets/aggregate")) {
        return jsonResponse({
          data: { aggregate: { balances: [{ mint: USDC_DEVNET, token: USDC_DEVNET }] } },
        });
      }
      if (url.pathname.endsWith("/wallets")) return jsonResponse({ data: { wallets: [] } });
      return jsonResponse({ data: { counterparties: [], pagination: { totalPages: 1 } } });
    });

    const options = await fetchTransactionFilterOptions(failing);

    expect(options.assets).toEqual([{ id: USDC_DEVNET, label: "USDC" }]);
  });
});
