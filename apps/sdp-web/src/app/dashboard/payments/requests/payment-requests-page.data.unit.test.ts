import type { PaymentRequest } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  fetchPaymentRequestDetail,
  loadPaymentRequestsList,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  PAYMENT_REQUESTS_SCAN_CAP,
  type PaymentRequestsListState,
  parsePaymentRequestsListParams,
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
  it("reads the page, its size and the status from the URL", () => {
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

type StoredStatus = "awaiting_payment" | "paid" | "canceled";

interface StoredRequest {
  id: string;
  status: StoredStatus;
  /** Paid on chain, so the next listing that reads it settles it as paid. */
  landed?: boolean;
  reference?: string;
  counterpartyId?: string | null;
}

/**
 * The list API over stored requests, newest first: it filters by the stored status, then
 * reconciles each open request it returns, saving any that has landed as paid, as the real
 * handler does. It records each call's page and status.
 */
function reconcilingApi(stored: StoredRequest[]) {
  const calls: { page: number; status: string | null }[] = [];
  const request = async (path: string) => {
    const query = new URL(path, "https://sdp.test").searchParams;
    const page = Number(query.get("page"));
    const pageSize = Number(query.get("pageSize"));
    const status = query.get("status");
    calls.push({ page, status });
    const matching = stored.filter((row) => status === null || row.status === status);
    const served = matching.slice((page - 1) * pageSize, page * pageSize).map((row) => {
      if (row.status === "awaiting_payment" && row.landed) row.status = "paid";
      return {
        id: row.id,
        status: row.status,
        amount: "1",
        token: "mint",
        destinationAddress: "dest",
        reference: row.reference ?? `ref_${row.id}`,
        counterpartyId: row.counterpartyId ?? null,
      } as PaymentRequest;
    });
    return Response.json({
      data: { paymentRequests: served, total: matching.length, page, pageSize },
    });
  };
  return { request: request as Parameters<typeof loadPaymentRequestsList>[0], calls };
}

function listState(changes: Partial<PaymentRequestsListState> = {}): PaymentRequestsListState {
  return { page: 1, pageSize: 25, status: null, search: null, ...changes };
}

function ids(rows: readonly PaymentRequest[]): string[] {
  return rows.map((row) => row.id);
}

describe("loadPaymentRequestsList", () => {
  it("pages on the server when nothing a payment can change is filtered", async () => {
    const api = reconcilingApi(
      Array.from({ length: 60 }, (_, index) => ({ id: `preq_${index}`, status: "canceled" }))
    );
    const result = await loadPaymentRequestsList(api.request, listState({ page: 2 }));
    expect(ids(result.data)).toEqual(
      Array.from({ length: 25 }, (_, index) => `preq_${25 + index}`)
    );
    expect(result.total).toBe(60);
    expect(api.calls).toEqual([{ page: 2, status: null }]);

    const canceled = reconcilingApi([{ id: "preq_c", status: "canceled" }]);
    await loadPaymentRequestsList(canceled.request, listState({ status: "canceled" }));
    expect(canceled.calls).toEqual([{ page: 1, status: "canceled" }]);
  });

  it("finds under Paid a request paid since it was last read", async () => {
    const api = reconcilingApi([
      { id: "preq_landed", status: "awaiting_payment", landed: true },
      { id: "preq_open", status: "awaiting_payment" },
      { id: "preq_paid", status: "paid" },
    ]);
    const result = await loadPaymentRequestsList(api.request, listState({ status: "paid" }));
    expect(ids(result.data)).toEqual(["preq_landed", "preq_paid"]);
    expect(result.total).toBe(2);
    expect(api.calls).toEqual([
      { page: 1, status: "awaiting_payment" },
      { page: 1, status: "paid" },
    ]);
  });

  it("leaves out of Awaiting payment a request that settles as it is read", async () => {
    const api = reconcilingApi([
      { id: "preq_landed", status: "awaiting_payment", landed: true },
      { id: "preq_open", status: "awaiting_payment" },
    ]);
    const result = await loadPaymentRequestsList(
      api.request,
      listState({ status: "awaiting_payment" })
    );
    expect(ids(result.data)).toEqual(["preq_open"]);
    expect(result.total).toBe(1);
    expect(api.calls).toEqual([{ page: 1, status: "awaiting_payment" }]);
  });

  it("searches requests past the page it shows, and pages the matches", async () => {
    const stored: StoredRequest[] = Array.from({ length: 240 }, (_, index) => ({
      id: `preq_${index}`,
      status: "canceled",
      ...(index % 40 === 0 ? { counterpartyId: "cpty_jane" } : {}),
    }));
    stored[230] = { id: "preq_230", status: "canceled", reference: "REF-OLD" };
    const api = reconcilingApi(stored);
    const counterpartyNames = async () => new Map([["cpty_jane", "Jane Smith"]]);

    const byReference = await loadPaymentRequestsList(
      api.request,
      listState({ search: "ref-old" }),
      {
        counterpartyNames,
      }
    );
    expect(ids(byReference.data)).toEqual(["preq_230"]);
    expect(byReference.searchCapped).toBe(false);

    const byName = await loadPaymentRequestsList(
      api.request,
      listState({ search: "jane", page: 2, pageSize: 4 }),
      { counterpartyNames }
    );
    expect(ids(byName.data)).toEqual(["preq_160", "preq_200"]);
    expect(byName.total).toBe(6);
  });

  it("says when a search stopped at the cap", async () => {
    const api = reconcilingApi(
      Array.from({ length: PAYMENT_REQUESTS_SCAN_CAP + 30 }, (_, index) => ({
        id: `preq_${index}`,
        status: "canceled",
      }))
    );
    const result = await loadPaymentRequestsList(api.request, listState({ search: "preq_" }));
    expect(result.total).toBe(PAYMENT_REQUESTS_SCAN_CAP);
    expect(result.searchCapped).toBe(true);
    expect(api.calls).toHaveLength(PAYMENT_REQUESTS_SCAN_CAP / PAYMENT_REQUESTS_PAGE_SIZE);
  });

  it("reports a failed read instead of a partial list", async () => {
    const request = (async () => new Response("boom", { status: 500 })) as unknown as Parameters<
      typeof loadPaymentRequestsList
    >[0];
    const result = await loadPaymentRequestsList(request, listState({ status: "paid" }));
    expect(result).toEqual({ ok: false, data: [], total: 0, error: "boom", searchCapped: false });
  });
});
