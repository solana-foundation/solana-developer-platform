import type { PaymentRequest } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  fetchPaymentRequestDetail,
  loadPaymentRequestsList,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  type PaymentRequestsListState,
  parsePaymentRequestsListParams,
  paymentRequestsListHref,
} from "./payment-requests-page.data";

function requestRow(id: string): PaymentRequest {
  return { id } as PaymentRequest;
}

/** A read-by-id API that knows the given requests and records each path it serves. */
function detailApi(known: PaymentRequest[], failure?: Response) {
  const paths: string[] = [];
  const request = async (path: string) => {
    paths.push(path);
    if (failure) return failure;
    const id = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    const match = known.find((candidate) => candidate.id === id);
    return match
      ? Response.json({ data: match })
      : Response.json({ error: { message: "Payment request not found" } }, { status: 404 });
  };
  return { request: request as Parameters<typeof fetchPaymentRequestDetail>[0], paths };
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

describe("fetchPaymentRequestDetail", () => {
  it("reads the request by id", async () => {
    const api = detailApi([requestRow("preq_120"), requestRow("preq/odd")]);
    expect(await fetchPaymentRequestDetail(api.request, "preq_120")).toEqual({
      status: "found",
      request: requestRow("preq_120"),
    });
    expect(await fetchPaymentRequestDetail(api.request, "preq/odd")).toEqual({
      status: "found",
      request: requestRow("preq/odd"),
    });
    expect(api.paths).toEqual([
      "/v1/payments/requests/preq_120",
      "/v1/payments/requests/preq%2Fodd",
    ]);
  });

  it("is not found when the API has no request by that id", async () => {
    const api = detailApi([requestRow("preq_120")]);
    expect(await fetchPaymentRequestDetail(api.request, "preq_missing")).toEqual({
      status: "not_found",
    });
  });

  it("reports any other failure as an error, not as missing", async () => {
    const api = detailApi([], new Response("boom", { status: 500 }));
    expect(await fetchPaymentRequestDetail(api.request, "preq_120")).toEqual({
      status: "error",
      error: "boom",
    });
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as Parameters<typeof fetchPaymentRequestDetail>[0];
    expect(await fetchPaymentRequestDetail(offline, "preq_120")).toEqual({
      status: "error",
      error: "offline",
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
 * call's page, size, status and search.
 */
function pageApi(rows: PaymentRequest[], total: number) {
  const calls: {
    page: string | null;
    pageSize: string | null;
    status: string | null;
    search: string | null;
  }[] = [];
  const request = async (path: string) => {
    const query = new URL(path, "https://sdp.test").searchParams;
    calls.push({
      page: query.get("page"),
      pageSize: query.get("pageSize"),
      status: query.get("status"),
      search: query.get("search"),
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
  it("reads the API's page, size, status and search, and returns its rows and total", async () => {
    const rows = [rowWithStatus("preq_1", "canceled"), rowWithStatus("preq_2", "expired")];
    const api = pageApi(rows, 60);
    const result = await loadPaymentRequestsList(
      api.request,
      listState({ page: 2, pageSize: 50, status: "canceled", search: "jane" })
    );
    expect(result).toEqual({ ok: true, data: rows, total: 60 });
    expect(api.calls).toEqual([{ page: "2", pageSize: "50", status: "canceled", search: "jane" }]);

    const unfiltered = pageApi(rows, 2);
    await loadPaymentRequestsList(unfiltered.request, listState());
    expect(unfiltered.calls).toEqual([{ page: "1", pageSize: "25", status: null, search: null }]);
  });

  it("passes a status filter's rows through as the API returns them", async () => {
    const rows = [
      rowWithStatus("preq_open", "awaiting_payment"),
      rowWithStatus("preq_later", "awaiting_payment"),
    ];
    const result = await loadPaymentRequestsList(
      pageApi(rows, 40).request,
      listState({ status: "awaiting_payment" })
    );
    expect(result).toEqual({ ok: true, data: rows, total: 40 });
  });

  it("reports a failed read", async () => {
    const request = (async () => new Response("boom", { status: 500 })) as unknown as Parameters<
      typeof loadPaymentRequestsList
    >[0];
    const result = await loadPaymentRequestsList(
      request,
      listState({ status: "awaiting_payment" })
    );
    expect(result).toEqual({ ok: false, data: [], total: 0, error: "boom" });
  });
});
