import type { Counterparty } from "@sdp/types/counterparties";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { setWindowPathname } from "@/test/window-location";
import {
  counterpartyListComplete,
  createTransferBatch,
  estimateTransferBatch,
  fetchRampEstimates,
  type Translate,
} from "./payments-workspace.data";

const t: Translate = (key) => key;

describe("createTransferBatch", () => {
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/pay"));
  afterEach(() => vi.unstubAllGlobals());

  it("sends the exact custody wallet id in the batch estimate and create bodies", async () => {
    const batch = {
      sourceCustodyWalletId: "cwlt_batch_source",
      token: requiredWellKnownMint("USDC", "devnet"),
      recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1" }],
    };
    const fetchMock = stubDashboardFetch(({ path }) =>
      path === "/api/dashboard/payments/transfers/batch/estimate"
        ? dashboardDataResponse(200, { estimate: { transactionCount: 1 } })
        : dashboardDataResponse(200, { batch: { id: "batch_1" }, recipients: [], transfers: [] })
    );

    await estimateTransferBatch(batch, t);
    await createTransferBatch(batch, t, { value: "idem_batch_1", persisted: true });

    expect(sentDashboardRequests(fetchMock).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/api/dashboard/payments/transfers/batch/estimate", body: batch },
      { path: "/api/dashboard/payments/transfers/batch", body: batch },
    ]);
  });

  it("surfaces a disabled batch movement with the API's actionable refusal", async () => {
    stubDashboardFetch(() =>
      Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "This movement is disabled for the project",
            details: { reason: "movement_disabled" },
          },
        },
        { status: 403 }
      )
    );

    await expect(
      createTransferBatch(
        {
          sourceCustodyWalletId: "cwlt_1",
          token: "USDC",
          recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1" }],
        },
        t,
        { value: "idem_batch_disabled", persisted: true }
      )
    ).rejects.toMatchObject({
      name: "TransferBatchRequestError",
      status: 403,
      code: "FORBIDDEN",
      replayed: false,
      message: "This movement is disabled for the project",
    });
  });
});

describe("fetchRampEstimates", () => {
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/deposit"));
  afterEach(() => vi.unstubAllGlobals());

  const request = {
    direction: "onramp",
    assetRail: "sol.solana",
    fiatCurrency: "USD",
    amount: "25",
  } as const;
  const estimate = {
    provider: "stripe",
    direction: "onramp",
    fiatCurrency: "USD",
    assetRail: "sol.solana",
    fiatAmount: "25",
    cryptoAmount: "0.2",
    exchangeRate: "110.25",
    totalFiatAmount: "26.02",
    fees: { currency: "USD", total: "1.02" },
  } as const;

  it("turns an estimate without a usable rate into that provider's error", async () => {
    const fetchMock = stubDashboardFetch(() =>
      Response.json({
        data: {
          estimates: [
            { provider: "moonpay", status: "ok", estimate: { ...estimate, exchangeRate: "0" } },
            { provider: "stripe", status: "ok", estimate },
          ],
        },
      })
    );

    expect(await fetchRampEstimates(request, t)).toEqual([
      {
        provider: "moonpay",
        status: "error",
        error: "DashboardPayments.workspace.rampEstimateInvalidRate",
      },
      { provider: "stripe", status: "ok", estimate },
    ]);
    // A buy is quoted from the fiat it spends.
    expect(
      sentDashboardRequests(fetchMock).map(({ path, method, body }) => ({ path, method, body }))
    ).toEqual([
      {
        path: "/api/dashboard/payments/ramps/onramp/estimate",
        method: "POST",
        body: { assetRail: "sol.solana", fiatCurrency: "USD", fiatAmount: "25" },
      },
    ]);
  });

  it("keeps an error's reason and the bound an amount crossed", async () => {
    const outOfRange = {
      provider: "moonpay",
      status: "error",
      error: "Amount is below the minimum",
      reason: "amount_below_minimum",
      limit: { amount: "20.00879", currency: "USDC" },
    } as const;
    stubDashboardFetch(() =>
      Response.json({
        data: { estimates: [outOfRange, { provider: "stripe", status: "unsupported" }] },
      })
    );

    expect(await fetchRampEstimates(request, t)).toEqual([
      outOfRange,
      { provider: "stripe", status: "unsupported" },
    ]);
  });

  it("refuses a response that is not an estimate list", async () => {
    stubDashboardFetch(() =>
      Response.json({ data: { estimates: [{ provider: "stripe", status: "ok" }] } })
    );

    await expect(fetchRampEstimates(request, t)).rejects.toThrow(
      "DashboardPayments.workspace.rampEstimateMissing"
    );
  });

  it.each([{ totalFiatAmount: "26,02" }, { fees: { currency: "USD", total: "1.02 USD" } }])(
    "refuses an estimate whose figures aren't decimals: %o",
    async (figures) => {
      stubDashboardFetch(() =>
        Response.json({
          data: {
            estimates: [
              { provider: "stripe", status: "ok", estimate: { ...estimate, ...figures } },
            ],
          },
        })
      );

      await expect(fetchRampEstimates(request, t)).rejects.toThrow(
        "DashboardPayments.workspace.rampEstimateMissing"
      );
    }
  );
});

describe("counterpartyListComplete", () => {
  const contact: Counterparty = {
    id: "cpty_one",
    organizationId: "org_test",
    projectId: "proj_test",
    externalId: null,
    displayName: "One",
    entityType: "business",
    status: "active",
    createdBy: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };

  it("reuses a read only when it holds the whole directory", () => {
    expect(counterpartyListComplete({ ok: true, data: [contact], total: 1 })).toBe(true);
    expect(counterpartyListComplete({ ok: true, data: [contact], total: 25 })).toBe(false);
    expect(counterpartyListComplete({ ok: false, data: [], total: 0 })).toBe(false);
    // A read that loaded every page names no total.
    expect(counterpartyListComplete({ ok: true, data: [contact] })).toBe(true);
  });
});
