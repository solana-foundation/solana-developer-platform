import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import {
  address,
  createNoopSigner,
  type Instruction,
  type MaybeAccount,
  type Signature,
} from "@solana/kit";
import { SUBSCRIPTIONS_PROGRAM_ADDRESS, type SubscriptionAuthority } from "@solana/subscriptions";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import {
  prepareSubscriptionAuthority,
  ResumedStepUnsettledError,
  readRecurringPaymentStep,
  type SavedStepSend,
  type SubscriptionStep,
} from "@/services/payments/recurring-payments/shared";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  epochInfoResult,
  installClusterRpcResponder,
  type StubSignatureStatus,
  signatureStatusesRead,
  signatureStatusesReplyAt,
} from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  confirmTransactionMock,
  DEVNET_USDC_MINT,
  fetchMaybeSubscriptionAuthorityMock,
  getAccountInfoMock,
  installPaymentsRouteTestHooks,
  sourceTokenAccountInfo,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SUBSCRIPTION_AUTHORITY,
  type TestAccountInfo,
} from "@/test/helpers/payments-routes";
import {
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  testSignature,
} from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import { TEST_MOCK_FEE_PAYER } from "@/test/helpers/sponsor-signing";

const SAVED_SEND = {
  signature: testSignature(1),
  lastValidBlockHeight: 1000n,
} satisfies SavedStepSend;
const CHAIN_TIP_SLOT = 2000;
const SAVED_SEND_READS: ReadonlySet<string> = new Set(["getEpochInfo", "getSignatureStatuses"]);
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
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET status = 'activating', plan_creation_signature = ?, updated_at = ?
          WHERE id = ?`
      )
      .bind(SAVED_SEND.signature, now, created.id)
      .run();
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

  function answerChain(
    blockHeight: number,
    statusSlot: number,
    status: StubSignatureStatus | null
  ) {
    rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: CHAIN_TIP_SLOT, blockHeight }));
    rpc.respond("getSignatureStatuses", () => signatureStatusesReplyAt(statusSlot, [status]));
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
      statusSlot: CHAIN_TIP_SLOT,
      status: null,
    },
    {
      state: "its saved send succeeded",
      effect: "none",
      blockHeight: 1001,
      statusSlot: CHAIN_TIP_SLOT,
      status: landedStatus(null),
    },
    {
      state: "its saved send has no record before expiry",
      effect: "none",
      blockHeight: 1000,
      statusSlot: CHAIN_TIP_SLOT,
      status: null,
    },
    {
      state: "its saved send failed only at processed (APE SOLA9-708)",
      effect: "none",
      blockHeight: 1001,
      statusSlot: CHAIN_TIP_SLOT,
      status: {
        slot: 100,
        confirmations: 0,
        confirmationStatus: "processed",
        err: { InstructionError: [0, { Custom: 1 }] },
      },
    },
    {
      state: "its saved send has no record past expiry from a node behind the tip",
      effect: "none",
      blockHeight: 1001,
      statusSlot: CHAIN_TIP_SLOT - 1,
      status: null,
    },
  ] as const)(
    "keeps a step in flight when $state",
    async ({ effect, blockHeight, statusSlot, status }) => {
      answerChain(blockHeight, statusSlot, status);

      await expect(readStep(effect, SAVED_SEND)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
      expect(await savedRows()).toEqual(untouchedRows);
    }
  );

  it("clears a saved send that failed on chain, then fails the step", async () => {
    answerChain(1000, CHAIN_TIP_SLOT, landedStatus({ InstructionError: [0, { Custom: 1 }] }));

    await expect(readStep("none", SAVED_SEND)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    });
    expect(await savedRows()).toEqual(clearedRows);
  });

  it("clears a saved send with no record past its expiry, reading the chain tip first, and sends the step", async () => {
    answerChain(1001, CHAIN_TIP_SLOT, null);

    expect(await readStep("none", SAVED_SEND)).toEqual({
      kind: "not_sent",
      account: { exists: false },
    });
    expect(savedSendReads()).toEqual(["getEpochInfo", "getSignatureStatuses"]);
    expect(
      rpc.requests
        .filter(({ method }) => method === "getSignatureStatuses")
        .map(signatureStatusesRead)
    ).toEqual([
      { cluster: "devnet", signatures: [SAVED_SEND.signature], searchTransactionHistory: true },
    ]);
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
    answerChain(1001, CHAIN_TIP_SLOT, null);

    await expect(readStep("none", SAVED_SEND)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
    expect(await savedRows()).toEqual({ ...untouchedRows, attempt_signature: testSignature(2) });
  });
});

const SETUP_PROGRAMS = {
  tokenAccount: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  authority: SUBSCRIPTIONS_PROGRAM_ADDRESS,
} as const;
const SETUP_FAILED = "Recurring payment setup failed on-chain";
const MISSING_AUTHORITY = {
  exists: false,
  address: TEST_SUBSCRIPTION_AUTHORITY.address,
} as const satisfies MaybeAccount<SubscriptionAuthority>;
const SOURCE_OWNER = address(TEST_SOLANA_ADDRESSES.wallet1);
const DELEGATING_TO_AUTHORITY = sourceTokenAccountInfo(TEST_SUBSCRIPTION_AUTHORITY.address, 1n);

describe("prepareSubscriptionAuthority", () => {
  installPaymentsRouteTestHooks();
  installClusterRpcResponder();

  function setupSender() {
    const sendSetup = vi.fn<(instruction: Instruction) => Promise<Signature>>();
    sendSetup.mockImplementation(async () => testSignature(sendSetup.mock.calls.length));
    return sendSetup;
  }

  function prepare(
    tokenAccountExists: boolean,
    sendSetup: (instruction: Instruction) => Promise<Signature>
  ) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      prepareSubscriptionAuthority({
        rpc: createClusterRpc(),
        sourceSigner: createNoopSigner(SOURCE_OWNER),
        sourceTokenAccount: {
          tokenAccount: address(TEST_SOLANA_ADDRESSES.wallet2),
          exists: tokenAccountExists,
        },
        subscriptionAuthorityAddress: TEST_SUBSCRIPTION_AUTHORITY.address,
        owner: SOURCE_OWNER,
        mint: address(DEVNET_USDC_MINT),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        feePayer: TEST_MOCK_FEE_PAYER,
        failureMessage: SETUP_FAILED,
        sendSetup,
      })
    );
  }

  it.each<{
    state: string;
    sourceToken: TestAccountInfo | null;
    firstAuthorityRead: MaybeAccount<SubscriptionAuthority>;
    created: (keyof typeof SETUP_PROGRAMS)[];
    authorityReads: number;
  }>([
    {
      state: "the token account is missing",
      sourceToken: null,
      firstAuthorityRead: TEST_SUBSCRIPTION_AUTHORITY,
      created: ["tokenAccount", "authority"],
      authorityReads: 1,
    },
    {
      state: "the authority is missing",
      sourceToken: DELEGATING_TO_AUTHORITY,
      firstAuthorityRead: MISSING_AUTHORITY,
      created: ["authority"],
      authorityReads: 2,
    },
    {
      state: "the token account delegates to another address",
      sourceToken: sourceTokenAccountInfo(syntheticAddress(1), 1_000_000n),
      firstAuthorityRead: TEST_SUBSCRIPTION_AUTHORITY,
      created: ["authority"],
      authorityReads: 2,
    },
    {
      state: "the authority's allowance is spent",
      sourceToken: sourceTokenAccountInfo(TEST_SUBSCRIPTION_AUTHORITY.address, 0n),
      firstAuthorityRead: TEST_SUBSCRIPTION_AUTHORITY,
      created: ["authority"],
      authorityReads: 2,
    },
    {
      state: "the authority exists with allowance left",
      sourceToken: DELEGATING_TO_AUTHORITY,
      firstAuthorityRead: TEST_SUBSCRIPTION_AUTHORITY,
      created: [],
      authorityReads: 1,
    },
  ])(
    "sends one confirmed transaction per setup instruction needed when $state",
    async ({ sourceToken, firstAuthorityRead, created, authorityReads }) => {
      getAccountInfoMock.mockResolvedValue(sourceToken);
      fetchMaybeSubscriptionAuthorityMock.mockResolvedValueOnce(firstAuthorityRead);
      const sendSetup = setupSender();

      expect(await prepare(sourceToken !== null, sendSetup)).toBe(TEST_SUBSCRIPTION_AUTHORITY);
      expect(sendSetup.mock.calls.map(([instruction]) => instruction.programAddress)).toEqual(
        created.map((account) => SETUP_PROGRAMS[account])
      );
      expect(confirmTransactionMock.mock.calls.map(([, signature]) => signature)).toEqual(
        created.map((_, index) => testSignature(index + 1))
      );
      expect(fetchMaybeSubscriptionAuthorityMock).toHaveBeenCalledTimes(authorityReads);
    }
  );

  it("sends no authority init when the token account's create fails on chain", async () => {
    confirmTransactionMock.mockResolvedValueOnce({
      signature: testSignature(1),
      slot: 100n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    });
    const sendSetup = setupSender();

    await expect(prepare(false, sendSetup)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message: SETUP_FAILED,
    });
    expect(sendSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps the step in flight while the authority it created is not visible at confirmed", async () => {
    fetchMaybeSubscriptionAuthorityMock
      .mockResolvedValueOnce(MISSING_AUTHORITY)
      .mockResolvedValueOnce(MISSING_AUTHORITY);
    const sendSetup = setupSender();

    await expect(prepare(true, sendSetup)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
    expect(sendSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps the step in flight and sends nothing while the token account is not visible at confirmed", async () => {
    getAccountInfoMock.mockResolvedValueOnce(null);
    const sendSetup = setupSender();

    await expect(prepare(true, sendSetup)).rejects.toBeInstanceOf(ResumedStepUnsettledError);
    expect(sendSetup).not.toHaveBeenCalled();
  });
});
