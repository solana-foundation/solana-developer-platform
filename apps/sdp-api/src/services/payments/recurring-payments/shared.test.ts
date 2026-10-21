import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import {
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  type SavedStepSend,
  type SubscriptionStep,
} from "@/services/payments/recurring-payments/shared";
import type { StubSignatureStatus } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_ORG,
  TEST_PROJECT,
} from "@/test/helpers/payments-routes";
import {
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  testSignature,
} from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";

const SAVED_SEND = {
  signature: testSignature(1),
  lastValidBlockHeight: 1000n,
} satisfies SavedStepSend;
const SAVED_SEND_READS: ReadonlySet<string> = new Set(["getBlockHeight", "getSignatureStatuses"]);
const STEP_EFFECTS = {
  finalized: { finalized: true, confirmed: true },
  confirmed: { finalized: false, confirmed: true },
  none: { finalized: false, confirmed: false },
} as const satisfies Record<string, Record<"finalized" | "confirmed", boolean>>;

function landedStatus(err: StubSignatureStatus["err"]): StubSignatureStatus {
  return { slot: 100, confirmations: null, confirmationStatus: "finalized", err };
}

describe("readRecurringPaymentStep", () => {
  installPaymentsRouteTestHooks();
  const { rpc } = installRecurringExecutionHooks();
  let recurringPaymentId: string;
  let attemptId: string;
  let step: SubscriptionStep;

  beforeEach(async () => {
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const repo = createPostgresPaymentRecurringPaymentsRepository(getDb(env));
    const now = new Date().toISOString();
    const attempt = required(
      await repo.createActivationAttempt({
        id: `prpa_${crypto.randomUUID()}`,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        recurringPaymentId: created.id,
        status: "processing",
        stage: "create_plan",
        planCreationSignature: SAVED_SEND.signature,
        authorizationSignature: null,
        error: null,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      })
    );
    required(
      await repo.updateActivationAttempt({
        attemptId: attempt.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        lastValidBlockHeight: SAVED_SEND.lastValidBlockHeight.toString(),
        updatedAt: now,
      })
    );
    required(
      await repo.updateRecurringPaymentActivation({
        recurringPaymentId: created.id,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        planCreationSignature: SAVED_SEND.signature,
        updatedAt: now,
      })
    );
    recurringPaymentId = created.id;
    attemptId = attempt.id;
    step = {
      env,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      rows: [
        { slot: { row: "recurring_payment", column: "plan_creation_signature" }, id: created.id },
        { slot: { row: "activation_attempt", column: "plan_creation_signature" }, id: attempt.id },
      ],
    };
  });

  function readStep(effect: keyof typeof STEP_EFFECTS, savedSend: SavedStepSend | null) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      readRecurringPaymentStep({
        rpc: createClusterRpc(),
        read: async (commitment) => ({ exists: STEP_EFFECTS[effect][commitment] }),
        landed: (account) => account.exists,
        savedSend,
        step,
        failureMessage: "Recurring payment step failed on-chain",
        logContext: {
          recurring_payment_id: recurringPaymentId,
          attempt_id: attemptId,
          step: "create_plan",
        },
      })
    );
  }

  function answerChain(blockHeight: number, status: StubSignatureStatus | null) {
    rpc.answer("getBlockHeight", blockHeight);
    rpc.respondSignatureStatuses(() => status);
  }

  const savedSendReads = () =>
    rpc.calls.map(({ method }) => method).filter((method) => SAVED_SEND_READS.has(method));

  const savedRows = () =>
    getDb(env)
      .prepare(
        `SELECT rp.plan_creation_signature AS schedule_signature,
                a.plan_creation_signature AS attempt_signature,
                a.last_valid_block_height
           FROM payment_recurring_payments rp
           JOIN payment_recurring_payment_activation_attempts a ON a.recurring_payment_id = rp.id
          WHERE rp.id = ?`
      )
      .bind(recurringPaymentId)
      .first<{
        schedule_signature: string | null;
        attempt_signature: string | null;
        last_valid_block_height: string | null;
      }>();

  const untouchedRows = {
    schedule_signature: SAVED_SEND.signature,
    attempt_signature: SAVED_SEND.signature,
    last_valid_block_height: "1000",
  };
  const clearedRows = {
    schedule_signature: null,
    attempt_signature: null,
    last_valid_block_height: null,
  };

  it("takes a step whose effect is final as landed without reading its saved send", async () => {
    expect(await readStep("finalized", SAVED_SEND)).toEqual({
      kind: "landed",
      account: { exists: true },
    });
    expect(savedSendReads()).toEqual([]);
  });

  it("sends a step no run saved a send for", async () => {
    expect(await readStep("none", null)).toEqual({ kind: "not_sent", account: { exists: false } });
    expect(savedSendReads()).toEqual([]);
  });

  it.each([
    {
      state: "its effect shows only at confirmed",
      effect: "confirmed",
      blockHeight: 1001,
      status: null,
    },
    {
      state: "its saved send succeeded",
      effect: "none",
      blockHeight: 1000,
      status: landedStatus(null),
    },
    {
      state: "its saved send has no record before expiry",
      effect: "none",
      blockHeight: 1000,
      status: null,
    },
  ] as const)("keeps a step in flight when $state", async ({ effect, blockHeight, status }) => {
    answerChain(blockHeight, status);

    await expect(readStep(effect, SAVED_SEND)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
    expect(await savedRows()).toEqual(untouchedRows);
  });

  it("clears a saved send that failed on chain, then fails the step", async () => {
    answerChain(1000, landedStatus({ InstructionError: [0, { Custom: 1 }] }));

    await expect(readStep("none", SAVED_SEND)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    });
    expect(await savedRows()).toEqual(clearedRows);
  });

  it("clears a saved send with no record past its expiry, reading the height first, and sends the step", async () => {
    answerChain(1001, null);

    expect(await readStep("none", SAVED_SEND)).toEqual({
      kind: "not_sent",
      account: { exists: false },
    });
    expect(savedSendReads()).toEqual(["getBlockHeight", "getSignatureStatuses"]);
    expect(await savedRows()).toEqual(clearedRows);
  });

  it("leaves every row as it was when one no longer holds the expired send", async () => {
    required(
      await createPostgresPaymentRecurringPaymentsRepository(getDb(env)).updateActivationAttempt({
        attemptId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        planCreationSignature: testSignature(2),
        updatedAt: new Date().toISOString(),
      })
    );
    answerChain(1001, null);

    await expect(readStep("none", SAVED_SEND)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
    expect(await savedRows()).toEqual({ ...untouchedRows, attempt_signature: testSignature(2) });
  });
});
