import type { PaymentRequest } from "@sdp/types/payments";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { TEST_PAYMENT_REQUEST_RECIPIENT, testPaymentRequest } from "@/test/payment-requests";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import {
  fetchPaymentRequestCanceler,
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

function requestRow(id: string, changes: Partial<PaymentRequest>): PaymentRequest {
  return testPaymentRequest({
    id,
    token: requiredWellKnownMint("USDC", "mainnet-beta"),
    amount: "1",
    ...changes,
  });
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
  const request = requestRow("preq_1", { amount: "12.5", reference: "INV-42" });

  it("matches the amount, token symbol, destination or reference, ignoring case", () => {
    for (const needle of [
      "12.5",
      WELL_KNOWN_TOKENS.USDC.symbol.toLowerCase(),
      TEST_PAYMENT_REQUEST_RECIPIENT.slice(0, 8).toLowerCase(),
      "inv-42",
    ]) {
      expect(paymentRequestMatchesSearch(request, needle)).toBe(true);
    }
  });

  it("matches nothing else", () => {
    expect(paymentRequestMatchesSearch(request, "john")).toBe(false);
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
    const row = requestRow("preq_120", {});
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
  const request: Parameters<typeof loadPaymentRequestsList>[0] = async (path) => {
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
  return { request, calls };
}

function rowWithStatus(id: string, status: PaymentRequest["status"]): PaymentRequest {
  return requestRow(id, { status });
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

  it("reports a failed read", async () => {
    const request: Parameters<typeof loadPaymentRequestsList>[0] = async () =>
      new Response("boom", { status: 500 });
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

describe("fetchPaymentRequestCanceler", () => {
  const canceled = (overrides: Partial<PaymentRequest>) =>
    requestRow("preq_1", {
      status: "canceled",
      canceledAt: "2026-09-15T00:00:00.000Z",
      ...overrides,
    });
  const json = <T>(body: T, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const member = (id: string, name: string | null, email = `${id}@example.com`) => ({
    user: { id, email, name },
  });
  const unused = async (): Promise<Response> => {
    throw new Error("not read");
  };

  it("reads nothing for a request that is not canceled", async () => {
    expect(await fetchPaymentRequestCanceler(unused, requestRow("preq_1", {}))).toBeNull();
  });

  it("names the API key from the Project's keys", async () => {
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return json({ data: { id: "key_1", name: "Checkout bot" } });
    };

    expect(
      await fetchPaymentRequestCanceler(request, canceled({ canceledByApiKeyId: "key_1" }))
    ).toEqual({ kind: "api_key", id: "key_1", name: "Checkout bot" });
    expect(paths).toEqual(["/v1/api-keys/key_1"]);
  });

  it("names the member by name, else email, reading pages until it finds them", async () => {
    const paths: string[] = [];
    const membersRequest = async (path: string) => {
      paths.push(path);
      return path.includes("page=1&")
        ? json({ data: { members: [member("usr_1", "Ada")], meta: { hasMore: true } } })
        : json({ data: { members: [member("usr_2", " ")], meta: { hasMore: false } } });
    };

    expect(
      await fetchPaymentRequestCanceler(membersRequest, canceled({ canceledByUserId: "usr_2" }))
    ).toEqual({ kind: "member", id: "usr_2", name: "usr_2@example.com" });
    expect(paths).toEqual(["/v1/members?page=1&pageSize=100", "/v1/members?page=2&pageSize=100"]);
  });

  it("leaves the name out when the read is refused, fails, or finds nobody", async () => {
    const refused = async () => json({ error: { message: "Forbidden" } }, 403);
    const broken = async () => json({ unexpected: true });
    const empty = async () => json({ data: { members: [], meta: { hasMore: false } } });

    expect(
      await fetchPaymentRequestCanceler(refused, canceled({ canceledByApiKeyId: "key_1" }))
    ).toEqual({ kind: "api_key", id: "key_1", name: null });
    expect(
      await fetchPaymentRequestCanceler(broken, canceled({ canceledByUserId: "usr_1" }))
    ).toEqual({ kind: "member", id: "usr_1", name: null });
    expect(
      await fetchPaymentRequestCanceler(empty, canceled({ canceledByUserId: "usr_1" }))
    ).toEqual({ kind: "member", id: "usr_1", name: null });
  });
});
