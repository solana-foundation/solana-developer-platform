import type { PaymentRequest } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  fetchPaymentRequestDetail,
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  parsePaymentRequestsListParams,
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
    expect(parsePaymentRequestsListParams({ page: "3", pageSize: "50", status: "paid" })).toEqual({
      page: 3,
      pageSize: 50,
      status: "paid",
    });
  });

  it("falls back on anything missing or malformed, and caps the size at the API's", () => {
    expect(parsePaymentRequestsListParams({ page: "0", pageSize: "abc", status: "nope" })).toEqual({
      page: 1,
      pageSize: PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
      status: null,
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
