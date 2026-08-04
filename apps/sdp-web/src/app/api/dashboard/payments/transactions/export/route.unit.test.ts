import type { PaymentTransferSummary } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
}));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { GET } from "./route";

function exportRequest(query = ""): Request {
  return new Request(
    `https://dashboard.example.com/api/dashboard/payments/transactions/export${query}`
  );
}

function transfer(overrides: Partial<PaymentTransferSummary>): PaymentTransferSummary {
  return {
    id: "trf_test",
    status: "confirmed",
    signature: null,
    rampsMemo: {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("GET /api/dashboard/payments/transactions/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requests filtered transfer pages from the SDP API and returns escaped CSV", async () => {
    const request = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [
          transfer({
            id: "trf_1",
            amount: "12.50",
            token: "USDC",
            memo: 'Invoice, "Q3"\npaid',
            createdAt: "2026-07-27T10:00:00.000Z",
          }),
        ],
        meta: { total: 1, hasMore: false },
      })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(
      exportRequest("?search=invoice&status=confirmed&wallet=wal_1&page=4")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="sdp-transactions-export-\d{4}-\d{2}-\d{2}\.csv"$/
    );

    expect(request).toHaveBeenCalledTimes(1);
    const apiPath = new URL(`https://api.example.test${request.mock.calls[0]?.[0]}`);
    expect(apiPath.pathname).toBe("/v1/payments/transfers");
    expect(apiPath.searchParams.get("search")).toBe("invoice");
    expect(apiPath.searchParams.get("status")).toBe("confirmed");
    expect(apiPath.searchParams.get("wallet")).toBe("wal_1");
    expect(apiPath.searchParams.get("page")).toBe("1");
    expect(apiPath.searchParams.get("pageSize")).toBe("100");

    const csvHeader =
      "id,createdAt,updatedAt,type,status,direction,amount,token,walletId,counterpartyId,source,destination,provider,providerReference,signature,memo";
    const csvRow = [
      "trf_1",
      "2026-07-27T10:00:00.000Z",
      "",
      "",
      "confirmed",
      "",
      "12.50",
      "USDC",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      '"Invoice, ""Q3""\npaid"',
    ].join(",");
    await expect(response.text()).resolves.toBe(`${csvHeader}\n${csvRow}\n`);
  });

  it("prefixes spreadsheet formula values in exported CSV fields", async () => {
    const request = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [
          transfer({
            id: "trf_formula",
            amount: "=1+1",
            source: "+source",
            providerReference: " \t@reference",
            memo: "\u0000-memo",
          }),
          transfer({
            id: "trf_unicode_formula",
            amount: "\u00a0=1+1",
            source: "\u200b+source",
            providerReference: "\u2060@reference",
            memo: "\ufeff-memo",
          }),
        ],
        meta: { total: 2, hasMore: false },
      })
    );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(exportRequest());
    const csv = await response.text();

    expect(csv).toContain(
      "trf_formula,,,,confirmed,,'=1+1,,,,'+source,,,' \t@reference,,'\u0000-memo\n"
    );

    expect(csv).toContain(
      "trf_unicode_formula,,,,confirmed,,'\u00a0=1+1,,,,'\u200b+source,,,'\u2060@reference,,'\ufeff-memo\n"
    );
  });

  it("uses response metadata to fetch the required pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [transfer({ id: "trf_1" })],
          meta: { total: 250, hasMore: true },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [transfer({ id: "trf_2" })],
          meta: { total: 250, hasMore: true },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [transfer({ id: "trf_3" })],
          meta: { total: 250, hasMore: false },
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(exportRequest());

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      new URL(`https://api.example.test${request.mock.calls[0]?.[0]}`).searchParams.get("page")
    ).toBe("1");
    expect(
      new URL(`https://api.example.test${request.mock.calls[1]?.[0]}`).searchParams.get("page")
    ).toBe("2");
    expect(
      new URL(`https://api.example.test${request.mock.calls[2]?.[0]}`).searchParams.get("page")
    ).toBe("3");
    await expect(response.text()).resolves.toContain("trf_3");
  });

  it("does not keep paging past the reported total", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [transfer({ id: "trf_1" })],
          meta: { total: 101, hasMore: true },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [transfer({ id: "trf_2" })],
          meta: { total: 101, hasMore: true },
        })
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(exportRequest());

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("returns upstream API errors as JSON", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Project scope is required" } },
          { status: 400, statusText: "Bad Request" }
        )
      );
    mocks.createSdpApiClient.mockResolvedValue({ request });

    const response = await GET(exportRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { message: "Project scope is required" },
    });
  });
});
