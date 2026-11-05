import type { PaymentRequest } from "@sdp/types/payments";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { SANDBOX_PROJECT } from "@/test/projects";
import {
  PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE,
  PAYMENT_REQUESTS_PAGE_SIZE,
  type PaymentRequestsListState,
  parsePaymentRequestsListParams,
  paymentRequestMatchesSearch,
  paymentRequestsListHref,
  paymentRequestsListView,
  readMemberDirectory,
} from "./payment-requests-page.data";

function requestRow(id: string, overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    id,
    organizationId: "org_1",
    projectId: "prj_1",
    walletId: "wal_1",
    destinationAddress: "11111111111111111111111111111111",
    token: MAINNET_USDC,
    amount: "1",
    reference: "ref_1",
    status: "awaiting_payment",
    expiresAt: null,
    fulfilledByTransferId: null,
    paidLate: false,
    canceledByApiKeyId: null,
    canceledByUserId: null,
    canceledAt: null,
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
    destinationAddress: "Dest1111111111111111111111111111111111111111",
    reference: "INV-42",
  });

  it("matches the amount, token symbol, destination or reference, ignoring case", () => {
    for (const needle of ["12.5", "usdc", "dest111", "inv-42"]) {
      expect(paymentRequestMatchesSearch(request, needle)).toBe(true);
    }
  });

  it("matches nothing else", () => {
    expect(paymentRequestMatchesSearch(request, "john")).toBe(false);
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

function rowWithStatus(id: string, status: PaymentRequest["status"]): PaymentRequest {
  return requestRow(id, { status });
}

function listState(changes: Partial<PaymentRequestsListState>): PaymentRequestsListState {
  return { page: 1, pageSize: 25, status: null, search: null, ...changes };
}

describe("paymentRequestsListView", () => {
  it("passes a page's rows and total through, with a next page while the total reaches past it", () => {
    const rows = [rowWithStatus("preq_1", "paid"), rowWithStatus("preq_2", "canceled")];
    const page = { paymentRequests: rows, total: 51, page: 2, pageSize: 25 };

    expect(paymentRequestsListView(page, listState({ page: 2 }))).toEqual({
      rows,
      total: 51,
      totalIsExact: true,
      hasNextPage: true,
    });
    expect(paymentRequestsListView(page, listState({ page: 3 })).hasNextPage).toBe(false);
  });

  it("leaves out of Awaiting payment a row the API returns as paid, and marks its total inexact", () => {
    const open = rowWithStatus("preq_open", "awaiting_payment");
    const page = {
      paymentRequests: [open, rowWithStatus("preq_landed", "paid")],
      total: 40,
      page: 1,
      pageSize: 25,
    };

    expect(paymentRequestsListView(page, listState({ status: "awaiting_payment" }))).toEqual({
      rows: [open],
      total: 40,
      totalIsExact: false,
      hasNextPage: true,
    });
  });
});

describe("readMemberDirectory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the members page by page under the key's Project until the last, sending no cap", async () => {
    const member = (id: string) => ({ user: { id, email: `${id}@example.com`, name: null } });
    const fetchMock = stubDashboardFetch(({ path }) =>
      Response.json({
        data: path.includes("page=1&")
          ? { members: [member("usr_1")], meta: { hasMore: true } }
          : { members: [member("usr_2")], meta: { hasMore: false } },
      })
    );

    const members = await readMemberDirectory(
      paymentsQueryKeys.memberDirectory({ projectId: SANDBOX_PROJECT.id, mode: "live" })
    );

    expect(members.map((user) => user.id)).toEqual(["usr_1", "usr_2"]);
    expect(sentDashboardReads(fetchMock)).toEqual([
      {
        path: "/api/dashboard/members?page=1&pageSize=100",
        projectId: SANDBOX_PROJECT.id,
        demo: null,
      },
      {
        path: "/api/dashboard/members?page=2&pageSize=100",
        projectId: SANDBOX_PROJECT.id,
        demo: null,
      },
    ]);
  });
});
