/**
 * Regression coverage for delayed recurring-payment activation (APE-775 /
 * SOLA9-535): a pending recurring payment whose requested `firstCollectionAt`
 * expired before activation must not keep that stale timestamp as its active
 * due time. Activation has to resolve the requested time against the actual
 * authorization period start, persist one normalized due time to both
 * `payment_recurring_payments.next_collection_due_at` and
 * `payment_subscriptions.next_collection_due_at`, and leave the row
 * unselectable by the due worker until the first eligible collection.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  createOrgSignerMock,
  DEVNET_USDC_MINT,
  installPaymentsRouteTestHooks,
  sendTransactionMock,
  TEST_CUSTODY_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  activateRecurringPaymentFixture,
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  parseCollectionResponse,
  RECURRING_HEADERS,
  setRecurringCollectionDue,
} from "@/test/helpers/recurring-payments";

const PERIOD_HOURS = 24;
const PERIOD_MS = PERIOD_HOURS * 60 * 60 * 1000;

interface ActivationScheduleState {
  status: string;
  first_collection_at: string | null;
  recurring_due_at: string | null;
  current_period_start_at: string | null;
  subscription_due_at: string | null;
}

async function readActivationScheduleState(
  recurringPaymentId: string
): Promise<ActivationScheduleState> {
  const state = await getDb(env)
    .prepare(
      `SELECT rp.status,
              rp.first_collection_at,
              rp.next_collection_due_at AS recurring_due_at,
              s.current_period_start_at,
              s.next_collection_due_at AS subscription_due_at
         FROM payment_recurring_payments rp
         JOIN payment_subscriptions s
           ON s.id = rp.subscription_id
          AND s.organization_id = rp.organization_id
          AND s.project_id = rp.project_id
        WHERE rp.id = ?`
    )
    .bind(recurringPaymentId)
    .first<ActivationScheduleState>();
  expect(state).not.toBeNull();
  return state as ActivationScheduleState;
}

describe("Payments routes — recurring activation schedule (APE-775)", () => {
  installPaymentsRouteTestHooks();
  installRecurringExecutionHooks();

  beforeEach(() => {
    createOrgSignerForCustodyWalletMock.mockImplementation((signerEnv, orgId, projectId) =>
      createOrgSignerMock(signerEnv, orgId, projectId)
    );
  });

  it("normalizes an expired firstCollectionAt to the first eligible collection", async () => {
    const firstCollectionAt = new Date(Date.now() + 100).toISOString();
    const recurringPayment = await createRecurringPaymentFixture({
      headers: RECURRING_HEADERS,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: PERIOD_HOURS,
      firstCollectionAt,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const activationResponse = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(activationResponse.status).toBe(200);

    const state = await readActivationScheduleState(recurringPayment.id);
    expect(state.status).toBe("active");

    // One resolved due time, atomically mirrored to both tables.
    expect(state.recurring_due_at).toBe(state.subscription_due_at);

    // The due time must never precede the first eligible collection, i.e. the
    // authorization period start plus one full period.
    const dueTime = new Date(state.recurring_due_at ?? "").getTime();
    const firstEligibleTime = new Date(state.current_period_start_at ?? "").getTime() + PERIOD_MS;
    expect(dueTime).toBeGreaterThanOrEqual(firstEligibleTime);

    // The due worker must not treat the freshly activated row as overdue.
    const now = new Date().toISOString();
    const dueRows = await createPostgresPaymentRecurringPaymentsRepository(
      getDb(env)
    ).listDueCollectionPayments({
      dueBefore: now,
      retryBefore: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      limit: 25,
    });
    expect(dueRows.map((row) => row.id)).not.toContain(recurringPayment.id);
  });

  it("honors a future firstCollectionAt beyond the first period", async () => {
    const firstCollectionAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const recurringPayment = await createRecurringPaymentFixture({
      headers: RECURRING_HEADERS,
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: DEVNET_USDC_MINT,
      amount: "25.00",
      periodHours: PERIOD_HOURS,
      firstCollectionAt,
    });

    const activationResponse = await app.request(
      `/v1/payments/recurring-payments/${recurringPayment.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(activationResponse.status).toBe(200);

    const state = await readActivationScheduleState(recurringPayment.id);
    expect(state.status).toBe("active");
    expect(state.recurring_due_at).toBe(firstCollectionAt);
    expect(state.subscription_due_at).toBe(firstCollectionAt);

    const now = new Date().toISOString();
    const dueRows = await createPostgresPaymentRecurringPaymentsRepository(
      getDb(env)
    ).listDueCollectionPayments({
      dueBefore: now,
      retryBefore: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      limit: 25,
    });
    expect(dueRows.map((row) => row.id)).not.toContain(recurringPayment.id);
  });

  it("advances collection finalization from the authorization period boundary, not a drifted due time", async () => {
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      headers: RECURRING_HEADERS,
    });

    // Simulate a legacy row whose local due time drifted behind its
    // authorization boundary (possible for rows activated before APE-775).
    const authoritativePeriodStart = await getDb(env)
      .prepare("SELECT current_period_start_at FROM payment_subscriptions WHERE id = ?")
      .bind(activated.subscriptionId)
      .first<{ current_period_start_at: string }>();
    const periodStartAt = authoritativePeriodStart?.current_period_start_at;
    expect(periodStartAt).toBeTruthy();

    const driftedDueAt = new Date(
      new Date(periodStartAt ?? "").getTime() - 60 * 1000
    ).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt: driftedDueAt,
    });

    // First collection attempt: force an ambiguous submission so the attempt
    // stays processing with a stored signature.
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
    const ambiguousResponse = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(ambiguousResponse.status).toBe(200);
    expect((await parseCollectionResponse(ambiguousResponse)).data.collectionAttempt).toMatchObject(
      { status: "processing" }
    );

    // Second collection attempt recovers the stored signature, verifies the
    // on-chain proof, and finalizes the schedule.
    const collectionResponse = await app.request(
      `/v1/payments/recurring-payments/${activated.id}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
    expect(collectionResponse.status).toBe(200);
    const collected = await parseCollectionResponse(collectionResponse);
    expect(collected.data.collectionAttempt).toMatchObject({ status: "confirmed" });

    const state = await readActivationScheduleState(activated.id);
    // The period boundary must never move backward to the drifted due time.
    expect(new Date(state.current_period_start_at ?? "").getTime()).toBeGreaterThanOrEqual(
      new Date(periodStartAt ?? "").getTime()
    );
    // Both tables mirror one schedule anchored one full period after the
    // authoritative boundary.
    expect(state.recurring_due_at).toBe(state.subscription_due_at);
    expect(new Date(state.recurring_due_at ?? "").getTime()).toBe(
      new Date(state.current_period_start_at ?? "").getTime() + PERIOD_MS
    );
    expect(new Date(state.recurring_due_at ?? "").getTime()).toBeGreaterThan(
      new Date(driftedDueAt).getTime()
    );
  });
});
