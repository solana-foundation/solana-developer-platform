import type { PaymentRequest } from "@sdp/types/payments";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import {
  fetchPaymentRequestDetail,
  fetchPaymentRequestLinkToken,
  loadPaymentRequestsList,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  type PaymentRequestsListState,
  parsePaymentRequestsListParams,
  paymentRequestMatchesSearch,
  paymentRequestsListHref,
} from "./payment-requests-page.data";

function requestRow(id: string, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id,
    organizationId: "org_1",
    projectId: "prj_1",
    counterpartyId: null,
    walletId: "wal_1",
    destinationAddress: "11111111111111111111111111111111",
    token: MAINNET_USDC,
    amount: "1",
    reference: "ref_1",
    status: "awaiting_payment",
    expiresAt: null,
    fulfilledByTransferId: null,
    canceledBy: null,
    lifecycle: [{ status: "awaiting_payment", at: "2026-09-14T00:00:00.000Z" }],
    createdBy: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

const MAINNET_USDC = mainnetUsdc();

function mainnetUsdc(): string {
  const mint = wellKnownMint("USDC", "mainnet-beta");
  if (!mint) throw new Error("USDC has no mainnet mint");
  return mint;
}

describe("parsePaymentRequestsListParams", () => {
  it("reads the page, its size, the status and the search from the URL", () => {
    expect(
      parsePaymentRequestsListParams({ page: "3", pageSize: "50", status: "paid", search: " ab " })
    ).toEqual({ page: 3, pageSize: 50, status: "paid", search: "ab" });
  });

  it("falls back on anything missing or malformed, and caps the size at the API's", () => {
    expect(
      parsePaymentRequestsListParams({ page: "0", pageSize: "abc", status: "nope", search: "  " })
    ).toEqual({
      page: 1,
      pageSize: PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
      status: null,
      search: null,
    });
    expect(parsePaymentRequestsListParams({ pageSize: "1000" }).pageSize).toBe(
      PAYMENT_REQUESTS_PAGE_SIZE
    );
  });
});

describe("paymentRequestMatchesSearch", () => {
  const request = requestRow("preq_1", {
    amount: "12.5",
    counterpartyId: "cp_1",
    destinationAddress: "Dest1111111111111111111111111111111111111111",
    reference: "INV-42",
  });
  const names = new Map([["cp_1", "Jane Doe"]]);

  it("matches the amount, token symbol, payer, destination or reference, ignoring case", () => {
    for (const needle of ["12.5", "usdc", "jane", "dest111", "inv-42"]) {
      expect(paymentRequestMatchesSearch(request, needle, names)).toBe(true);
    }
  });

  it("matches nothing else", () => {
    expect(paymentRequestMatchesSearch(request, "john", names)).toBe(false);
    expect(paymentRequestMatchesSearch({ ...request, counterpartyId: null }, "jane", names)).toBe(
      false
    );
  });
});

describe("fetchPaymentRequestDetail", () => {
  function detailApi(response: Response) {
    const paths: string[] = [];
    const request: Parameters<typeof fetchPaymentRequestDetail>[0] = async (path) => {
      paths.push(path);
      return response;
    };
    return { request, paths };
  }

  it("reads the request by id", async () => {
    const row = requestRow("preq_120");
    const api = detailApi(Response.json({ data: row }));
    const result = await fetchPaymentRequestDetail(api.request, "preq_120");
    expect(result).toEqual({ status: "found", request: row });
    expect(api.paths).toEqual(["/v1/payments/requests/preq_120"]);
  });

  it("is not found on a 404", async () => {
    const api = detailApi(new Response(null, { status: 404 }));
    expect(await fetchPaymentRequestDetail(api.request, "preq_missing")).toEqual({
      status: "not_found",
    });
  });
});

describe("fetchPaymentRequestLinkToken", () => {
  function linkApi(response: Response) {
    const paths: string[] = [];
    const request: Parameters<typeof fetchPaymentRequestLinkToken>[0] = async (path) => {
      paths.push(path);
      return response;
    };
    return { request, paths };
  }

  it("reads the token from the link endpoint", async () => {
    const api = linkApi(Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }));
    expect(await fetchPaymentRequestLinkToken(api.request, "preq_1")).toEqual({
      ok: true,
      publicToken: "tok_1",
    });
    expect(api.paths).toEqual(["/v1/payments/requests/preq_1/link"]);
  });

  it("answers no token when the member may not manage payment requests", async () => {
    const api = linkApi(new Response(null, { status: 403 }));
    expect(await fetchPaymentRequestLinkToken(api.request, "preq_1")).toEqual({
      ok: true,
      publicToken: null,
    });
  });
});

describe("paymentRequestsListHref", () => {
  it("leaves out whatever is at its default", () => {
    expect(paymentRequestsListHref({ page: 1, pageSize: 25, status: null, search: null })).toBe(
      "/dashboard/payments/requests"
    );
    expect(paymentRequestsListHref({ page: 3, pageSize: 50, status: "paid", search: "jane" })).toBe(
      "/dashboard/payments/requests?page=3&pageSize=50&status=paid&search=jane"
    );
  });
});

/**
 * A list API that serves `rows` as one page with `total`, whatever was asked, and records each
 * call's page, size and status.
 */
function pageApi(rows: PaymentRequest[], total: number) {
  const calls: { page: string | null; pageSize: string | null; status: string | null }[] = [];
  const request = async (path: string) => {
    const query = new URL(path, "https://sdp.test").searchParams;
    calls.push({
      page: query.get("page"),
      pageSize: query.get("pageSize"),
      status: query.get("status"),
    });
    return Response.json({
      data: { paymentRequests: rows, total, page: 1, pageSize: rows.length },
    });
  };
  return { request: request as Parameters<typeof loadPaymentRequestsList>[0], calls };
}

function rowWithStatus(id: string, status: PaymentRequest["status"]): PaymentRequest {
  return { id, status } as PaymentRequest;
}

function listState(changes: Partial<PaymentRequestsListState> = {}): PaymentRequestsListState {
  return { page: 1, pageSize: 25, status: null, search: null, ...changes };
}

describe("loadPaymentRequestsList", () => {
  it("reads the API's page, size and status, and returns its rows and total", async () => {
    const rows = [rowWithStatus("preq_1", "canceled"), rowWithStatus("preq_2", "expired")];
    const api = pageApi(rows, 60);
    const result = await loadPaymentRequestsList(
      api.request,
      listState({ page: 2, pageSize: 50, status: "canceled" })
    );
    expect(result).toEqual({
      ok: true,
      data: rows,
      total: 60,
      totalIsExact: true,
      hasNextPage: false,
    });
    expect(api.calls).toEqual([{ page: "2", pageSize: "50", status: "canceled" }]);

    const unfiltered = pageApi(rows, 2);
    await loadPaymentRequestsList(unfiltered.request, listState());
    expect(unfiltered.calls).toEqual([{ page: "1", pageSize: "25", status: null }]);
  });

  it("leaves out of Awaiting payment a row the API returns as paid, and marks its total inexact", async () => {
    const api = pageApi(
      [rowWithStatus("preq_open", "awaiting_payment"), rowWithStatus("preq_landed", "paid")],
      40
    );
    const result = await loadPaymentRequestsList(
      api.request,
      listState({ status: "awaiting_payment" })
    );
    expect(result.data).toEqual([rowWithStatus("preq_open", "awaiting_payment")]);
    expect(result.total).toBe(40);
    expect(result.totalIsExact).toBe(false);
    expect(result.hasNextPage).toBe(true);
  });

  it("offers a next page while the API's total reaches past this one", async () => {
    const rows = [rowWithStatus("preq_1", "paid")];
    const last = await loadPaymentRequestsList(
      pageApi(rows, 51).request,
      listState({ page: 3, pageSize: 25, status: "paid" })
    );
    expect(last.hasNextPage).toBe(false);
    const middle = await loadPaymentRequestsList(
      pageApi(rows, 51).request,
      listState({ page: 2, pageSize: 25, status: "paid" })
    );
    expect(middle.hasNextPage).toBe(true);
  });

  it("passes Paid's rows through as the API returns them", async () => {
    const rows = [rowWithStatus("preq_1", "paid"), rowWithStatus("preq_2", "paid")];
    const result = await loadPaymentRequestsList(
      pageApi(rows, 2).request,
      listState({ status: "paid" })
    );
    expect(result).toEqual({
      ok: true,
      data: rows,
      total: 2,
      totalIsExact: true,
      hasNextPage: false,
    });
  });

  it("reports a failed read", async () => {
    const request = (async () => new Response("boom", { status: 500 })) as unknown as Parameters<
      typeof loadPaymentRequestsList
    >[0];
    const result = await loadPaymentRequestsList(
      request,
      listState({ status: "awaiting_payment" })
    );
    expect(result).toEqual({
      ok: false,
      data: [],
      total: 0,
      error: "boom",
      totalIsExact: true,
      hasNextPage: false,
    });
  });
});
