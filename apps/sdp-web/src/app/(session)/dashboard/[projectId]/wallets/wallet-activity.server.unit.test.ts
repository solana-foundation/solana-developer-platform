import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Translate, WalletActivityPayload } from "./wallet-activity.data";

const flags = vi.hoisted(() => ({ issuance: vi.fn() }));

// The deployment's Issuance flag, the one ambient input the loader reads.
vi.mock("@/flags", () => ({ issuance: flags.issuance }));

import { loadWalletActivity } from "./wallet-activity.server";

const t: Translate = (key) => key;
const wallet = { custodyWalletId: "cwlt_1", providerWalletId: "privy_1" };

beforeEach(() => {
  flags.issuance.mockResolvedValue(true);
});

/** The payload of a load, which always answers `ok`; a missing payload fails here. */
function payloadOf(result: Awaited<ReturnType<typeof loadWalletActivity>>): WalletActivityPayload {
  expect(result.ok).toBe(true);
  if (result.data === undefined) {
    throw new Error("The wallet activity load answered without a payload");
  }
  return result.data;
}

describe("loadWalletActivity", () => {
  it("uses the exact wallet identity for Payments and Issuance", async () => {
    const request = vi.fn(
      async (_path: string) => new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    await loadWalletActivity(request, wallet, t);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/issuance/transactions?custodyWalletId=cwlt_1&page=1&pageSize=20",
    ]);
  });

  it("never reads Issuance when it is off, and raises no issuance notice", async () => {
    flags.issuance.mockResolvedValue(false);
    const request = vi.fn(
      async (_path: string) => new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const result = await loadWalletActivity(request, wallet, t);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=20&custodyWalletId=cwlt_1&includeObserved=true",
    ]);
    expect(payloadOf(result)).toEqual({
      activityRows: [],
      activityError: null,
      activityNotice: null,
      hasMore: false,
    });
  });

  // An Issuance read that never ran counted as a loaded source, so a failed payments read
  // showed an empty history instead of its error.
  it("reports a failed payments read as the error when Issuance is off", async () => {
    flags.issuance.mockResolvedValue(false);
    const request = vi.fn(
      async (_path: string) =>
        new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
    );

    const result = await loadWalletActivity(request, wallet, t);

    expect(payloadOf(result)).toEqual({
      activityRows: [],
      activityError: "DashboardCustody.walletActivityUnavailable",
      activityNotice: null,
      hasMore: false,
    });
  });
});

describe("loadWalletActivity windows", () => {
  function transfer(index: number) {
    return {
      id: `xfr_${index}`,
      custodyWalletId: "cwlt_1",
      providerWalletId: "privy_1",
      rampsMemo: {},
      status: "finalized",
      direction: "outbound",
      createdAt: new Date(Date.UTC(2026, 8, 1) - index * 60_000).toISOString(),
    };
  }

  function requestWith(transferCount: number, issuanceCount: number) {
    return vi.fn(async (path: string) => {
      const query = new URL(path, "https://api.example.com").searchParams;
      const page = Number(query.get("page"));
      const pageSize = Number(query.get("pageSize"));
      const start = (page - 1) * pageSize;
      if (path.startsWith("/v1/payments/transfers?")) {
        const rows = Array.from(
          { length: Math.max(0, Math.min(pageSize, transferCount - start)) },
          (_, offset) => transfer(start + offset)
        );
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      const rows = Array.from({ length: Math.min(pageSize, issuanceCount) }, (_, index) => ({
        token: { symbol: WELL_KNOWN_TOKENS.USDC.symbol, name: WELL_KNOWN_TOKENS.USDC.name },
        transaction: {
          id: `itx_${index}`,
          type: "mint",
          status: "confirmed",
          signature: null,
          params: {},
          createdAt: new Date(Date.UTC(2026, 7, 1) - index * 60_000).toISOString(),
        },
      }));
      return new Response(JSON.stringify({ data: rows }), { status: 200 });
    });
  }

  it("reads a window wider than a transfers page across parallel pages of 100", async () => {
    const request = requestWith(250, 3);

    const result = await loadWalletActivity(request, wallet, t, { pageSize: 220 });

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/v1/payments/transfers?page=1&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/payments/transfers?page=2&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/payments/transfers?page=3&pageSize=100&custodyWalletId=cwlt_1&includeObserved=true",
      "/v1/issuance/transactions?custodyWalletId=cwlt_1&page=1&pageSize=220",
    ]);
    const { activityRows, hasMore } = payloadOf(result);
    expect(activityRows.map((row) => row.id)).toEqual(
      Array.from({ length: 220 }, (_, index) => `payment-xfr_${index}`)
    );
    expect(hasMore).toBe(true);
  });

  it("reports older rows while a source fills the window or the merge drops rows", async () => {
    const full = payloadOf(await loadWalletActivity(requestWith(20, 0), wallet, t));
    expect(full.hasMore).toBe(true);

    const merged = payloadOf(await loadWalletActivity(requestWith(15, 10), wallet, t));
    expect(merged.activityRows).toHaveLength(20);
    expect(merged.hasMore).toBe(true);

    const complete = payloadOf(await loadWalletActivity(requestWith(12, 3), wallet, t));
    expect(complete.activityRows).toHaveLength(15);
    expect(complete.hasMore).toBe(false);
  });

  it("fails the transfers source as a whole when any of its pages fails", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.includes("page=2&")) {
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await loadWalletActivity(request, wallet, t, { pageSize: 150 });

    expect(payloadOf(result)).toEqual({
      activityRows: [],
      activityError: null,
      activityNotice: "DashboardCustody.paymentsActivityUnavailable",
      hasMore: false,
    });
  });
});
