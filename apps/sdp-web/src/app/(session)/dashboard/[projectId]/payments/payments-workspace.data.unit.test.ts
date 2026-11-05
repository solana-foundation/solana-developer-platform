import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardReadError } from "@/lib/dashboard-swr";
import { SANDBOX_PROJECT } from "@/test/projects";
import { setWindowPathname } from "@/test/window-location";
import { paymentsQueryKeys } from "./payments-query-key";
import {
  createTransfer,
  createTransferBatch,
  readRampEstimates,
  TransferRequestError,
} from "./payments-workspace.data";

const t = ((key: string) => key) as Parameters<typeof createTransfer>[1];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Payments write requests", () => {
  beforeEach(() => setWindowPathname("/dashboard/prj_test_sandbox/payments/pay"));
  afterEach(() => vi.unstubAllGlobals());

  const transferInput = {
    sourceCustodyWalletId: "cwlt_1",
    destination: "destination",
    token: address("So11111111111111111111111111111111111111112"),
    amount: "1",
  };

  it("sends the exact custody wallet id, the tab's Project, and the caller's key or one per action", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ data: { transfer: { id: "trf_1", status: "pending", signature: null } } })
      );
    vi.stubGlobal("fetch", fetch);

    await createTransfer({ ...transferInput, transferId: "xfr_1" }, t, {
      value: "idem_transfer_1",
      persisted: true,
    });
    await createTransfer(transferInput, t, null);

    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ ...transferInput, transferId: "xfr_1" });

    const [keyed, unkeyed] = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers);
    expect(keyed).toEqual(
      new Headers({
        "Content-Type": "application/json",
        "Idempotency-Key": "idem_transfer_1",
        "x-project-id": "prj_test_sandbox",
      })
    );
    // A caller without its own key still gets one per user action (HOO-1918).
    const unkeyedHeaders = new Headers(unkeyed);
    expect(unkeyedHeaders.get("x-project-id")).toBe("prj_test_sandbox");
    expect(unkeyedHeaders.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats a 202 SIGNING_PENDING body like any other unexpected response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "SIGNING_PENDING",
              message: "Approval required",
              details: { approvalRequestId: "apr_1" },
            },
          },
          202
        )
      )
    );

    await expect(
      createTransfer(transferInput, t, { value: "idem_transfer_1", persisted: true })
    ).rejects.toThrow("DashboardPayments.workspace.transferMissing");
  });

  it("carries the status of a refusal so the caller can decide the key's fate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Insufficient balance" } }, 422))
    );

    const refusal = await createTransfer(transferInput, t, {
      value: "idem_transfer_1",
      persisted: true,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TransferRequestError);
    expect(refusal).toMatchObject({ status: 422, message: "Insufficient balance" });
  });

  it("uses the exact custody wallet id for a batch create", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ data: { batch: { id: "batch_1" }, recipients: [], transfers: [] } });
    });

    await createTransferBatch(
      {
        sourceCustodyWalletId: "cwlt_1",
        token: "mint",
        recipients: [{ counterpartyId: "cp_1", counterpartyAccountId: "acct_1", amount: "1" }],
      },
      t,
      { value: "idem_batch_1", persisted: true }
    );

    expect(bodies).toEqual([expect.objectContaining({ sourceCustodyWalletId: "cwlt_1" })]);
    expect(bodies[0]).not.toHaveProperty("source");
  });

  it("surfaces a disabled batch movement with the API's actionable refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "FORBIDDEN",
              message: "This movement is disabled for the project",
              details: { reason: "movement_disabled" },
            },
          },
          403
        )
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
      message: "This movement is disabled for the project",
    });
  });
});

describe("readRampEstimates", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = paymentsQueryKeys.rampEstimate(
    { projectId: SANDBOX_PROJECT.id, mode: "live" },
    { direction: "onramp", assetRail: "sol.solana", fiatCurrency: "USD", amount: "25" }
  );
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            estimates: [
              { provider: "moonpay", status: "ok", estimate: { ...estimate, exchangeRate: "0" } },
              { provider: "stripe", status: "ok", estimate },
            ],
          },
        })
      )
    );

    expect(await readRampEstimates(request, t)).toEqual([
      {
        provider: "moonpay",
        status: "error",
        error: "DashboardPayments.workspace.rampEstimateInvalidRate",
      },
      { provider: "stripe", status: "ok", estimate },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { estimates: [outOfRange, { provider: "stripe", status: "unsupported" }] },
        })
      )
    );

    expect(await readRampEstimates(request, t)).toEqual([
      outOfRange,
      { provider: "stripe", status: "unsupported" },
    ]);
  });

  it("refuses a response that is not an estimate list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: { estimates: [{ provider: "stripe", status: "ok" }] } })
      )
    );

    await expect(readRampEstimates(request, t)).rejects.toBeInstanceOf(DashboardReadError);
  });

  it.each([{ totalFiatAmount: "26,02" }, { fees: { currency: "USD", total: "1.02 USD" } }])(
    "refuses an estimate whose figures aren't decimals: %o",
    async (figures) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          jsonResponse({
            data: {
              estimates: [
                { provider: "stripe", status: "ok", estimate: { ...estimate, ...figures } },
              ],
            },
          })
        )
      );

      await expect(readRampEstimates(request, t)).rejects.toBeInstanceOf(DashboardReadError);
    }
  );
});
