import type { PaymentRequest } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  fetchPaymentRequestDetail,
  loadPaymentRequestsList,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  type PaymentRequestsListState,
  parsePaymentRequestsListParams,
  paymentRequestMatchesSearch,
  paymentRequestsListHref,
} from "./payment-requests-page.data";

function requestRow(id: string): PaymentRequest {
  return { id } as PaymentRequest;
}

/** A list API over `total` requests, newest first, that records each page it serves. */
function listApi(total: number) {
  const pages: number[] = [];
  const request = async (path: string) => {
    const query = new URL(path, "https://sdp.test").searchParams;
    const page = Number(query.get("page"));
    const pageSize = Number(query.get("pageSize"));
    pages.push(page);
    const start = (page - 1) * pageSize;
    const ids = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - start)) },
      (_, index) => `preq_${start + index}`
    );
    return Response.json({
      data: { paymentRequests: ids.map(requestRow), total, page, pageSize },
    });
  };
  return { request, pages };
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
  const request = {
    id: "preq_1",
    amount: "12.5",
    token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    counterpartyId: "cp_1",
    destinationAddress: "Dest1111111111111111111111111111111111111111",
    reference: "INV-42",
  } as PaymentRequest;
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
  it("stops at the page that holds the request", async () => {
    const api = listApi(250);
    const result = await fetchPaymentRequestDetail(
      api.request as Parameters<typeof fetchPaymentRequestDetail>[0],
      "preq_120"
    );
    expect(result).toEqual({ status: "found", request: requestRow("preq_120") });
    expect(api.pages).toEqual([1, 2]);
  });

  it("reaches requests older than any list cap", async () => {
    const api = listApi(720);
    const result = await fetchPaymentRequestDetail(
      api.request as Parameters<typeof fetchPaymentRequestDetail>[0],
      "preq_710"
    );
    expect(result).toEqual({ status: "found", request: requestRow("preq_710") });
    expect(api.pages).toHaveLength(8);
  });

  it("is not found once the pages run out", async () => {
    const api = listApi(150);
    const result = await fetchPaymentRequestDetail(
      api.request as Parameters<typeof fetchPaymentRequestDetail>[0],
      "preq_missing"
    );
    expect(result).toEqual({ status: "not_found" });
    expect(api.pages).toEqual([1, 2]);
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
