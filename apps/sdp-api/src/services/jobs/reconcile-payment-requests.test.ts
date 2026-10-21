import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type {
  PaymentRequestRow,
  PaymentRequestsRepository,
} from "@/db/repositories/payment-requests.repository";
import { createPostgresPaymentRequestsRepository } from "@/db/repositories/payment-requests.repository.postgres";
import * as repositoryFactory from "@/db/repositories/repository-factory";
import { AppError } from "@/lib/errors";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as paymentRequests from "@/services/payments/payment-requests";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { reconcilePaymentRequests } from "./reconcile-payment-requests";

function openPaymentRequestRow(id: string): PaymentRequestRow {
  return {
    id,
    public_token: `tok_${id}`,
    organization_id: "org_reconcile_sweep",
    project_id: "prj_reconcile_sweep",
    custody_wallet_id: "cwlt_reconcile_sweep",
    wallet_id: "wal_reconcile_sweep",
    destination_address: TEST_SOLANA_ADDRESSES.wallet1,
    token: SOL_MINT,
    amount: "1.5",
    reference: TEST_SOLANA_ADDRESSES.wallet3,
    status: "awaiting_payment",
    expires_at: null,
    fulfilled_by_transfer_id: null,
    canceled_by: null,
    last_checked_at: null,
    lifecycle: [],
    created_by: "usr_reconcile_sweep",
    created_at: "2026-06-14T12:00:00.000Z",
    updated_at: "2026-06-14T12:00:00.000Z",
  };
}

describe("reconcilePaymentRequests", () => {
  const listToReconcile = vi.fn<PaymentRequestsRepository["listPaymentRequestsToReconcile"]>();
  const markChecked = vi.fn<PaymentRequestsRepository["markPaymentRequestsChecked"]>();

  beforeEach(() => {
    listToReconcile.mockReset();
    markChecked.mockReset();
    markChecked.mockResolvedValue(undefined);
    vi.spyOn(repositoryFactory, "createSystemPaymentRequestsRepository").mockReturnValue({
      ...createPostgresPaymentRequestsRepository(getDb(env)),
      listPaymentRequestsToReconcile: listToReconcile,
      markPaymentRequestsChecked: markChecked,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runOnProduction() {
    return runInClusterScope({ projectId: null, environment: "production" }, () =>
      reconcilePaymentRequests(env)
    );
  }

  it("lists the scope's environment with the final-check window and reconciles each row best effort", async () => {
    const first = openPaymentRequestRow("preq_sweep_first");
    const second = openPaymentRequestRow("preq_sweep_second");
    listToReconcile.mockResolvedValue([first, second]);
    const reconcile = vi
      .spyOn(paymentRequests, "reconcilePaymentRequest")
      .mockImplementation(async (_env, row) => row);

    await runOnProduction();

    expect(listToReconcile).toHaveBeenCalledTimes(1);
    expect(listToReconcile).toHaveBeenCalledWith({
      environment: "production",
      finalCheckAfterMs: 600_000,
      limit: 200,
    });
    expect(reconcile.mock.calls).toEqual([
      [env, first, { bestEffort: true }],
      [env, second, { bestEffort: true }],
    ]);
    expect(markChecked.mock.calls).toEqual([[[first.id, second.id]]]);
  });

  it("keeps sweeping past a row that throws, stamps it with the rest, and reports it in the run summary", async () => {
    const failing = openPaymentRequestRow("preq_sweep_failing");
    const settling = openPaymentRequestRow("preq_sweep_settling");
    listToReconcile.mockResolvedValue([failing, settling]);
    const failure = new AppError("CONFLICT", "Recorded transfer does not match payment request");
    const reconcile = vi
      .spyOn(paymentRequests, "reconcilePaymentRequest")
      .mockImplementation(async (_env, row) => {
        if (row.id === failing.id) {
          throw failure;
        }
        return { ...row, status: "paid" };
      });
    const logEvent = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => {});

    await runOnProduction();

    expect(reconcile.mock.calls).toEqual([
      [env, failing, { bestEffort: true }],
      [env, settling, { bestEffort: true }],
    ]);
    expect(markChecked.mock.calls).toEqual([[[failing.id, settling.id]]]);
    expect(markChecked.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...reconcile.mock.invocationCallOrder)
    );
    expect(logEvent.mock.calls).toEqual([
      [
        "warn",
        {
          event: "sdp_api_payment_request_reconcile_failed",
          flow: "payment-request-settlement",
          payment_request_id: failing.id,
          environment: "production",
          error: "Recorded transfer does not match payment request",
          error_diagnostics: undefined,
        },
      ],
      [
        "info",
        {
          event: "sdp_api_payment_request_reconcile",
          flow: "payment-request-settlement",
          environment: "production",
          selected: 2,
          paid: 1,
          failed: 1,
        },
      ],
    ]);
  });
});
