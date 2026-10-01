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
  createdAt?: string;
}

/**
 * The list API over stored requests, newest first: it filters by the stored status, then
 * reconciles each open request it returns, saving any that has landed as paid, as the real
 * handler does. It records each call's page and status, then runs `afterRead` with that call's
 * page, so a test can change the requests between pages.
 */
function reconcilingApi(stored: StoredRequest[], afterRead?: (page: number) => void) {
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
        createdAt: row.createdAt,
      } as PaymentRequest;
    });
    afterRead?.(page);
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
    expect(api.calls).toEqual([{ page: 1, status: null }]);
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
    expect(api.calls).toEqual([{ page: 1, status: null }]);
  });

  it("skips no request when open ones leave Awaiting payment between pages", async () => {
    // 250 open requests. Reading the first page settles every other one of its 100; then,
    // before the next page, someone cancels a request already read and creates a new one.
    const loadPage = (page: number) => {
      const stored: StoredRequest[] = Array.from({ length: 250 }, (_, index) => ({
        id: `preq_${index}`,
        status: "awaiting_payment",
        landed: index < 100 && index % 2 === 0,
      }));
      const api = reconcilingApi(stored, (readPage) => {
        if (readPage !== 1 || stored[0]?.id === "preq_created") return;
        const read = stored.find((row) => row.id === "preq_1");
        if (read) read.status = "canceled";
        stored.unshift({ id: "preq_created", status: "awaiting_payment" });
      });
      return loadPaymentRequestsList(
        api.request,
        listState({ status: "awaiting_payment", page, pageSize: 100 })
      );
    };

    const [first, second] = await Promise.all([loadPage(1), loadPage(2)]);
    // Every request still open when its page was read, once each, newest first.
    const openIds = Array.from({ length: 250 }, (_, index) => index)
      .filter((index) => index >= 100 || index % 2 === 1)
      .map((index) => `preq_${index}`);
    expect([...ids(first.data), ...ids(second.data)]).toEqual(openIds);
    expect(first.total).toBe(openIds.length);
  });

  it("reads on when a request created mid-read pushes the oldest onto another page", async () => {
    const stored: StoredRequest[] = Array.from({ length: 200 }, (_, index) => ({
      id: `preq_${index}`,
      status: "canceled",
    }));
    const api = reconcilingApi(stored, (page) => {
      if (page === 1) stored.unshift({ id: "preq_created", status: "canceled" });
    });
    const result = await loadPaymentRequestsList(
      api.request,
      listState({ search: "preq_", page: 2, pageSize: 100 })
    );
    // The second page repeated preq_99, which is shown once; a third page held preq_199.
    expect(ids(result.data)).toEqual(
      Array.from({ length: 100 }, (_, index) => `preq_${100 + index}`)
    );
    expect(result.total).toBe(200);
    expect(api.calls.map((call) => call.page)).toEqual([1, 2, 3]);
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

  /** `count` canceled requests, newest first, each a second older than the one before. */
  function olderRequests(count: number): StoredRequest[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `preq_${index}`,
      status: "canceled",
      createdAt: new Date(Date.UTC(2026, 0, 1) - index * 1000).toISOString(),
    }));
  }

  it("finds under a status a request older than the unfiltered read", async () => {
    const total = PAYMENT_REQUESTS_SCAN_CAP + 100;
    const place = (index: number, changes: Partial<StoredRequest>) => {
      stored[index] = { ...(stored[index] as StoredRequest), ...changes };
    };
    const stored = olderRequests(total);
    place(540, { status: "paid", reference: "REF-MATCH" });
    place(560, { status: "awaiting_payment", landed: true, reference: "REF-MATCH" });
    place(580, { status: "awaiting_payment", reference: "REF-MATCH" });
    place(590, { status: "canceled", reference: "REF-MATCH" });
    place(10, { status: "paid", reference: "REF-MATCH" });
    const search = "ref-match";

    const paid = await loadPaymentRequestsList(
      reconcilingApi(stored).request,
      listState({ status: "paid", search })
    );
    // preq_560 was still stored open, and only the open read settles it as paid.
    expect(ids(paid.data)).toEqual(["preq_10", "preq_540", "preq_560"]);
    expect(paid.searchCapped).toBe(false);

    const open = await loadPaymentRequestsList(
      reconcilingApi(stored).request,
      listState({ status: "awaiting_payment", search })
    );
    expect(ids(open.data)).toEqual(["preq_580"]);
    expect(open.searchCapped).toBe(false);
  });

  it("skips no older request when reading a status's pages settles some of them", async () => {
    // Past the unfiltered read's 500, 300 older open requests, every fourth already paid on
    // chain: each page of the open read settles a quarter of its rows, which leave the set.
    const loadPage = (status: "awaiting_payment" | "paid", page: number) => {
      const stored = olderRequests(PAYMENT_REQUESTS_SCAN_CAP + 300).map(
        (row, index): StoredRequest =>
          index < PAYMENT_REQUESTS_SCAN_CAP
            ? row
            : { ...row, status: "awaiting_payment", landed: index % 4 === 0 }
      );
      return loadPaymentRequestsList(
        reconcilingApi(stored).request,
        listState({ status, search: "preq_", page, pageSize: 100 })
      );
    };
    const olderIds = (landed: boolean) =>
      Array.from({ length: 300 }, (_, offset) => PAYMENT_REQUESTS_SCAN_CAP + offset)
        .filter((index) => (index % 4 === 0) === landed)
        .map((index) => `preq_${index}`);

    const open = await Promise.all([1, 2, 3].map((page) => loadPage("awaiting_payment", page)));
    expect(open.flatMap((result) => ids(result.data))).toEqual(olderIds(false));
    expect(open[0]?.total).toBe(225);

    const paid = await loadPage("paid", 1);
    expect(ids(paid.data)).toEqual(olderIds(true));
  });

  it("says when a status's own read stopped at the cap", async () => {
    const stored = olderRequests(PAYMENT_REQUESTS_SCAN_CAP + 100).map(
      (row): StoredRequest => ({ ...row, status: "paid" })
    );
    const result = await loadPaymentRequestsList(
      reconcilingApi(stored).request,
      listState({ status: "paid", search: "preq_" })
    );
    expect(result.total).toBe(PAYMENT_REQUESTS_SCAN_CAP);
    expect(result.searchCapped).toBe(true);
  });

  it("reports a failed read instead of a partial list", async () => {
    const request = (async () => new Response("boom", { status: 500 })) as unknown as Parameters<
      typeof loadPaymentRequestsList
    >[0];
    const result = await loadPaymentRequestsList(request, listState({ status: "paid" }));
    expect(result).toEqual({ ok: false, data: [], total: 0, error: "boom", searchCapped: false });
  });
});
