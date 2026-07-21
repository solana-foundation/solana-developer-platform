import { describe, expect, it, vi } from "vitest";
import { fetchTransactionFilterOptions } from "./transactions-filter-options";

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
