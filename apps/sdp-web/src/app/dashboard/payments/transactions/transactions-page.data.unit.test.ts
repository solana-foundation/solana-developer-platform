import { describe, expect, it, vi } from "vitest";
import { fetchTransactionsPage } from "./transactions-page.data";
import { parseTransactionFilters } from "./transactions-query";

describe("fetchTransactionsPage", () => {
  it("performs one server-paginated request and preserves API metadata", async () => {
    const request = vi.fn(
      async (_path: string) =>
        new Response(
          JSON.stringify({
            data: [{ id: "transfer-1", status: "confirmed" }],
            meta: { page: 2, pageSize: 25, total: 51, hasMore: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const filters = parseTransactionFilters(
      { page: "2", status: "confirmed", search: "invoice" },
      new Date("2026-07-18T12:00:00.000Z")
    );

    const result = await fetchTransactionsPage(request, filters);

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toContain("includeObserved=false");
    expect(String(request.mock.calls[0]?.[0])).toContain("status=confirmed");
    expect(String(request.mock.calls[0]?.[0])).toContain("search=invoice");
    expect(result).toMatchObject({ page: 2, pageSize: 25, total: 51, hasMore: true });
    expect(result.transfers).toHaveLength(1);
  });
});
