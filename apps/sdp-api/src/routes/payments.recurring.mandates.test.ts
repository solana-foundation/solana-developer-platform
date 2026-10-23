import { runInClusterScope } from "@sdp/rpc/scope";
import type { ParsedTransaction } from "@sdp/rpc/solana";
import {
  AMOUNT_VERIFICATION_REASONS,
  AMOUNT_VERIFICATION_STATES,
  LEG_VERIFIERS,
  TOKEN_MOVEMENT_BASES,
} from "@sdp/types/token-movements";
import { TOKEN_PROGRAM_KINDS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import * as subscriptionsProgram from "@solana/subscriptions";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app as baseApp } from "@/index";
import { errorResponseSchema } from "@/openapi/schemas/base";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { epochInfoResult, type JsonRpcResult } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { withIdempotencyKeys } from "@/test/helpers/idempotency-keys";
import {
  confirmTransactionMock,
  getTransactionMock,
  installPaymentsRouteTestHooks,
  recurringCollectionTransactionForSignature,
  sendTransactionMock,
  TEST_ORG,
  TEST_PROJECT,
} from "@/test/helpers/payments-routes";
import {
  activateRecurringPaymentFixture,
  createRecurringPaymentFixture,
  DEFAULT_RECURRING_FIXTURE,
  installRecurringExecutionHooks,
  parseCollectionResponse,
  parseRecurringResponse,
  RECURRING_HEADERS,
  recurringMintAccounts,
  setRecurringCollectionDue,
  testSignature,
} from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import {
  answerMovementAccounts,
  associatedTokenAccount,
  mintRpcAccount,
  readsAccount,
  sentInstructions,
  tokenRpcAccount,
  transferFeeExtension,
} from "@/test/helpers/token-movement";

// Every mutation carries a fresh key unless a test sets its own (HOO-1918).
const app = withIdempotencyKeys(baseApp);

const PYUSD = WELL_KNOWN_TOKENS.PYUSD.mints.devnet.address;
const MINT_AUTHORITY = address("Sysvar1111111111111111111111111111111111111");

const mandateColumnsSchema = z.object({
  // A mandate moves an SPL token only.
  asset_kind: z.literal("token"),
  mint: z.string(),
  token_program: z.enum(TOKEN_PROGRAM_KINDS),
  decimals: z.number(),
  mandate_debit: z.string(),
  max_fee_per_pull: z.string(),
});

const legSchema = z.object({
  verified_by: z.enum(LEG_VERIFIERS),
  basis: z.enum(TOKEN_MOVEMENT_BASES),
  quoted_debit: z.string(),
  quoted_fee: z.string(),
  quoted_credit: z.string(),
  observed_debit: z.string().nullable(),
  observed_fee: z.string().nullable(),
  observed_credit: z.string().nullable(),
  verification_state: z.enum(AMOUNT_VERIFICATION_STATES),
  verification_reason: z.enum(AMOUNT_VERIFICATION_REASONS).nullable(),
});

describe("Payments routes — recurring mandates in base units (ADR 0012)", () => {
  installPaymentsRouteTestHooks();
  const recurringExecution = installRecurringExecutionHooks();

  beforeEach(() => {
    recurringExecution.rpc.answer(
      "getEpochInfo",
      epochInfoResult({ absoluteSlot: 2_000, blockHeight: 1_000 })
    );
    recurringExecution.rpc.respondSignatureStatuses(() => null);
  });

  /** PYUSD (Token-2022) with `extensions`, and the test wallets' accounts of it. */
  async function answerPyusd(options: {
    extensions: ExtensionArgs[];
    destinationExtensions: ExtensionArgs[];
    destinationFrozen: boolean;
  }) {
    const accounts = new Map<string, JsonRpcResult>(await recurringMintAccounts([]));
    accounts.set(
      PYUSD,
      mintRpcAccount("token-2022", { decimals: 6, extensions: options.extensions })
    );
    for (const owner of [
      recurringExecution.sourceSigner().address,
      ...Object.values(TEST_SOLANA_ADDRESSES),
    ]) {
      accounts.set(
        await associatedTokenAccount("token-2022", PYUSD, owner),
        tokenRpcAccount("token-2022", {
          mint: PYUSD,
          owner,
          amount: 1_000_000_000n,
          extensions:
            owner === TEST_SOLANA_ADDRESSES.wallet2
              ? [{ __kind: "ImmutableOwner" }, ...options.destinationExtensions]
              : [{ __kind: "ImmutableOwner" }],
          frozen: owner === TEST_SOLANA_ADDRESSES.wallet2 && options.destinationFrozen,
        })
      );
    }
    answerMovementAccounts(recurringExecution.rpc, accounts);
  }

  async function collect(recurringPaymentId: string) {
    return app.request(
      `/v1/payments/recurring-payments/${recurringPaymentId}/collect`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );
  }

  async function dueNow(activated: { id: string; subscriptionId: string }) {
    const dueAt = new Date(Date.now() - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    return dueAt;
  }

  async function collectionLeg(transferId: string) {
    return legSchema.parse(
      await getDb(env)
        .prepare(
          `SELECT verified_by, basis, quoted_debit, quoted_fee, quoted_credit, observed_debit,
                  observed_fee, observed_credit, verification_state, verification_reason
             FROM token_movement_legs WHERE payment_transfer_id = ?`
        )
        .bind(transferId)
        .first()
    );
  }

  it("stores the mandate once, and builds and verifies each pull from its base units", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    expect(activated.amounts).toEqual({
      basis: "debit",
      debit: "25",
      decimals: 6,
      maxFeePerPull: "0",
    });
    const mandate = {
      asset_kind: "token",
      mint: DEFAULT_RECURRING_FIXTURE.token,
      token_program: "spl-token",
      decimals: 6,
      mandate_debit: "25000000",
      max_fee_per_pull: "0",
    };
    for (const table of ["payment_recurring_payments", "payment_subscription_plans"]) {
      expect(
        mandateColumnsSchema.parse(
          await getDb(env)
            .prepare(
              `SELECT asset_kind, mint, token_program, decimals, mandate_debit, max_fee_per_pull
                 FROM ${table} WHERE id = ?`
            )
            .bind(table === "payment_recurring_payments" ? activated.id : activated.planId)
            .first()
        )
      ).toEqual(mandate);
    }
    await dueNow(activated);
    const requestsBefore = recurringExecution.rpc.requests.length;

    const response = await collect(activated.id);

    expect(response.status).toBe(200);
    const body = await parseCollectionResponse(response);
    // The pull's one terms read, before its claim; no supply read re-parses the amount.
    const reads = recurringExecution.rpc.requests
      .slice(requestsBefore)
      .map((request) => request.method)
      .filter((method) => method !== "getGenesisHash" && method !== "getSignatureStatuses");
    expect(reads).toEqual(["getMultipleAccounts"]);
    expect(getTransactionMock).toHaveBeenCalledTimes(1);
    const [, sent] = required(sendTransactionMock.mock.calls.at(-1));
    const pull = required(
      sentInstructions(sent).find(
        (instruction) =>
          instruction.programAddress === subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS
      )
    );
    expect(
      subscriptionsProgram
        .getTransferSubscriptionInstructionDataDecoder()
        .decode(required(pull.data)).transferData.amount
    ).toBe(25_000_000n);
    expect(await collectionLeg(body.data.transfer.id)).toEqual({
      verified_by: "chain",
      basis: "debit",
      quoted_debit: "25000000",
      quoted_fee: "0",
      quoted_credit: "25000000",
      observed_debit: "25000000",
      observed_fee: "0",
      observed_credit: "25000000",
      verification_state: "verified",
      verification_reason: "chain_delta_matched",
    });
  });

  it("makes the plan from an amount edited after a failed activation, and pulls that amount", async () => {
    // The plan creation fails on chain: the payment goes back to pending
    // activation and keeps the plan row that activation wrote.
    confirmTransactionMock.mockResolvedValueOnce({
      signature: testSignature(1),
      slot: 100n,
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, "Custom"] },
    });
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    const activate = () =>
      app.request(
        `/v1/payments/recurring-payments/${created.id}/activate`,
        { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
        env
      );
    expect((await activate()).status).toBe(400);
    const edited = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30.00" }) },
      env
    );
    expect(edited.status).toBe(200);
    // The failed plan never landed, so the retry finds no plan at either commitment.
    const noPlan = { exists: false, address: address(TEST_SOLANA_ADDRESSES.wallet3) } as const;
    vi.mocked(subscriptionsProgram.fetchMaybePlan)
      .mockResolvedValueOnce(noPlan)
      .mockResolvedValueOnce(noPlan);

    const activated = (await parseRecurringResponse(await activate())).data.recurringPayment;

    expect(activated.status).toBe("active");
    await dueNow({ id: activated.id, subscriptionId: required(activated.subscriptionId) });
    const response = await collect(activated.id);
    expect(response.status).toBe(200);
    const [, sent] = required(sendTransactionMock.mock.calls.at(-1));
    const pull = required(
      sentInstructions(sent).find(
        (instruction) =>
          instruction.programAddress === subscriptionsProgram.SUBSCRIPTIONS_PROGRAM_ADDRESS
      )
    );
    expect(
      subscriptionsProgram
        .getTransferSubscriptionInstructionDataDecoder()
        .decode(required(pull.data)).transferData.amount
    ).toBe(30_000_000n);
  });

  it("records a mismatch from the destination's raw balance delta and still confirms the pull", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    await dueNow(activated);
    getTransactionMock.mockImplementation(async (_rpc, signature) => {
      const landed = await recurringCollectionTransactionForSignature({ signature, decimals: 6 });
      if (landed === null) return null;
      // 0.001 USDC less reached the destination than the pull moved.
      const short: ParsedTransaction = {
        ...landed,
        postTokenBalances: required(landed.postTokenBalances).map((balance) => ({
          ...balance,
          amount: (BigInt(balance.amount) - 1_000n).toString(),
        })),
      };
      return short;
    });

    const response = await collect(activated.id);

    expect(response.status).toBe(200);
    const body = await parseCollectionResponse(response);
    expect(body.data.collectionAttempt.status).toBe("confirmed");
    expect(await collectionLeg(body.data.transfer.id)).toMatchObject({
      observed_debit: "25000000",
      observed_fee: "1000",
      observed_credit: "24999000",
      verification_state: "mismatch",
      verification_reason: "chain_delta_mismatch",
    });
  });

  it("finishes a stale amount update from its saved replacement plan after the fee grew to take the debit", async () => {
    await answerPyusd({ extensions: [transferFeeExtension(0, 0n)], destinationExtensions: [] });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    // The crashed run made the replacement plan for 30 under a 0 fee, then stopped.
    await getDb(env)
      .prepare(
        `INSERT INTO payment_subscription_plans
         SELECT (jsonb_populate_record(NULL::payment_subscription_plans, to_jsonb(plan) || jsonb_build_object(
                  'id', 'psp_saved_replacement', 'amount', '30', 'mandate_debit', '30000000',
                  'program_plan_id', '987654321', 'plan_pda', NULL, 'status', 'draft'))).*
           FROM payment_subscription_plans plan WHERE plan.id = ?`
      )
      .bind(activated.planId)
      .run();
    const before = {
      sourceCustodyWalletId: activated.sourceCustodyWalletId,
      counterpartyId: activated.counterpartyId,
      counterpartyAccountId: activated.counterpartyAccountId,
      token: activated.token,
      amount: activated.amount,
      periodHours: activated.periodHours,
      firstCollectionAt: activated.firstCollectionAt,
      nextCollectionDueAt: activated.nextCollectionDueAt,
      metadataUri: activated.metadataUri,
    };
    await getDb(env)
      .prepare(
        "UPDATE payment_recurring_payments SET status = 'updating', updated_at = ? WHERE id = ?"
      )
      .bind(staleAt, activated.id)
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_recurring_payment_update_attempts (
           id, organization_id, project_id, recurring_payment_id, mode, status, stage,
           old_plan_id, old_subscription_id, new_plan_id, changed_fields, before_values,
           after_values, created_at, updated_at
         ) VALUES (
           'prpu_stale_saved_plan', ?, ?, ?, 'replacement', 'processing', 'claim', ?, ?,
           'psp_saved_replacement', ARRAY['amount']::text[], ?::jsonb, ?::jsonb, ?, ?
         )`
      )
      .bind(
        TEST_ORG.id,
        TEST_PROJECT.id,
        activated.id,
        activated.planId,
        activated.subscriptionId,
        JSON.stringify(before),
        JSON.stringify({ ...before, amount: "30" }),
        staleAt,
        staleAt
      )
      .run();
    // Since then the fee grew to take every pull whole: a mandate made now would be refused.
    await answerPyusd({
      extensions: [transferFeeExtension(10_000, 1_000_000_000n)],
      destinationExtensions: [],
    });

    const response = await app.request(
      `/v1/payments/recurring-payments/${activated.id}`,
      { method: "PATCH", headers: RECURRING_HEADERS, body: JSON.stringify({ amount: "30" }) },
      env
    );

    expect(response.status).toBe(200);
    expect((await parseRecurringResponse(response)).data.recurringPayment).toMatchObject({
      status: "active",
      planId: "psp_saved_replacement",
    });
    const plan = mandateColumnsSchema.parse(
      await getDb(env)
        .prepare("SELECT * FROM payment_subscription_plans WHERE id = 'psp_saved_replacement'")
        .first()
    );
    expect(plan.mandate_debit).toBe("30000000");
  });

  it("refuses an amount with more decimals than the mint when a new mandate is made", async () => {
    const created = await createRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);

    const response = await app.request(
      `/v1/payments/recurring-payments/${created.id}`,
      {
        method: "PATCH",
        headers: RECURRING_HEADERS,
        body: JSON.stringify({ amount: "25.0000001" }),
      },
      env
    );

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.message).toBe(
      "Amount has too many decimal places"
    );
    expect(
      await getDb(env)
        .prepare("SELECT amount, mandate_debit FROM payment_recurring_payments WHERE id = ?")
        .bind(created.id)
        .first()
    ).toEqual({ amount: "25.00", mandate_debit: "25000000" });
  });

  it("refuses a pull whose mint changed its decimals since the mandate was made", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    await dueNow(activated);
    answerMovementAccounts(
      recurringExecution.rpc,
      new Map([
        [
          DEFAULT_RECURRING_FIXTURE.token,
          mintRpcAccount("spl-token", { decimals: 9, extensions: null }),
        ],
      ])
    );

    const response = await collect(activated.id);

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.message).toContain(
      "mint changed"
    );
  });

  it("holds a pull whose transfer fee is above the mandate's tolerance, with the period still due", async () => {
    await answerPyusd({
      extensions: [transferFeeExtension(0, 0n)],
      destinationExtensions: [],
      destinationFrozen: false,
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    expect(activated.amounts).toMatchObject({ maxFeePerPull: "0" });
    const dueAt = await dueNow(activated);
    await answerPyusd({
      extensions: [transferFeeExtension(50, 1_000_000n)],
      destinationExtensions: [],
      destinationFrozen: false,
    });
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const response = await collect(activated.id);

    expect(response.status).toBe(409);
    const error = errorResponseSchema.parse(await response.json()).error;
    expect(error.message).toContain("held");
    expect(error.details).toMatchObject({ reason: "fee_above_tolerance" });
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
    const attempts = await getDb(env)
      .prepare("SELECT status, transfer_id, metadata FROM payment_subscription_collection_attempts")
      .all();
    expect(attempts.results).toEqual([
      {
        status: "failed",
        transfer_id: null,
        metadata: expect.objectContaining({ source: "retry", holdReason: "fee_above_tolerance" }),
      },
    ]);
    const after = await parseRecurringResponse(
      await app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        { headers: RECURRING_HEADERS },
        env
      )
    );
    expect(after.data.recurringPayment.nextCollectionDueAt).toBe(dueAt);
  });

  it("skips a period still held when it ends, as the subscriptions program forfeits it", async () => {
    await answerPyusd({
      extensions: [transferFeeExtension(0, 0n)],
      destinationExtensions: [],
      destinationFrozen: false,
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    const periodMs = DEFAULT_RECURRING_FIXTURE.periodHours * 60 * 60 * 1000;
    // Due a period and a minute ago: the period has ended.
    const dueAt = new Date(Date.now() - periodMs - 60 * 1000).toISOString();
    await setRecurringCollectionDue({
      recurringPaymentId: activated.id,
      subscriptionId: activated.subscriptionId,
      dueAt,
    });
    await answerPyusd({
      extensions: [transferFeeExtension(50, 1_000_000n)],
      destinationExtensions: [],
      destinationFrozen: false,
    });
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const result = await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      collectDueRecurringPayments(env, new Date())
    );

    expect(result).toMatchObject({ collected: 0, failed: 0, skipped: 1 });
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
    const attempts = await getDb(env)
      .prepare("SELECT status, transfer_id, error FROM payment_subscription_collection_attempts")
      .all();
    expect(attempts.results).toEqual([
      { status: "skipped", transfer_id: null, error: expect.stringContaining("transfer fee") },
    ]);
    const after = await parseRecurringResponse(
      await app.request(
        `/v1/payments/recurring-payments/${activated.id}`,
        { headers: RECURRING_HEADERS },
        env
      )
    );
    expect(after.data.recurringPayment.nextCollectionDueAt).toBe(
      new Date(Date.parse(dueAt) + 2 * periodMs).toISOString()
    );
  });

  it("recovers a landed pull of a payment written before mandates from its plan's mandate, reading no terms", async () => {
    const activated = await activateRecurringPaymentFixture(DEFAULT_RECURRING_FIXTURE);
    // A payment row written before mandates; its plan holds the mandate that is on chain.
    await getDb(env)
      .prepare(
        `UPDATE payment_recurring_payments
            SET asset_kind = NULL, mint = NULL, token_program = NULL, decimals = NULL,
                mandate_debit = NULL, max_fee_per_pull = NULL
          WHERE id = ?`
      )
      .bind(activated.id)
      .run();
    await dueNow(activated);
    sendTransactionMock.mockRejectedValueOnce(new Error("RPC response lost"));
    const ambiguous = await parseCollectionResponse(await collect(activated.id));
    expect(ambiguous.data.collectionAttempt.status).toBe("processing");
    await getDb(env)
      .prepare(
        "UPDATE payment_subscription_collection_attempts SET idempotency_key = NULL WHERE subscription_id = ?"
      )
      .bind(activated.subscriptionId)
      .run();
    const landed = required(ambiguous.data.collectionAttempt.signature);
    recurringExecution.rpc.respondSignatureStatuses((signature) =>
      signature === landed
        ? { slot: 100, confirmations: null, confirmationStatus: "finalized", err: null }
        : null
    );
    // The mint can no longer be read: recovery proves the landed pull from the
    // stored mandate alone.
    answerMovementAccounts(recurringExecution.rpc, new Map());

    const recovered = await collect(activated.id);

    const recoveredText = await recovered.text();
    expect(recovered.status, recoveredText).toBe(200);
    const body = await parseCollectionResponse(new Response(recoveredText));
    expect(body.data.collectionAttempt).toMatchObject({ status: "confirmed", signature: landed });
  });

  it("holds a pull while the mint is paused", async () => {
    await answerPyusd({
      extensions: [{ __kind: "PausableConfig", authority: MINT_AUTHORITY, paused: false }],
      destinationExtensions: [],
      destinationFrozen: false,
    });
    const activated = await activateRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    await dueNow(activated);
    await answerPyusd({
      extensions: [{ __kind: "PausableConfig", authority: MINT_AUTHORITY, paused: true }],
      destinationExtensions: [],
      destinationFrozen: false,
    });

    const response = await collect(activated.id);

    expect(response.status).toBe(409);
    expect(errorResponseSchema.parse(await response.json()).error.details).toMatchObject({
      reason: "paused",
    });
    expect(
      recurringExecution.rpc.requests.some(
        (request) => request.method === "getMultipleAccounts" && readsAccount(request, PYUSD)
      )
    ).toBe(true);
  });

  it("refuses to activate a mandate whose destination requires memos", async () => {
    await answerPyusd({
      extensions: [],
      destinationExtensions: [{ __kind: "MemoTransfer", requireIncomingTransferMemos: true }],
      destinationFrozen: false,
    });
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const response = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.details).toMatchObject({
      reason: "memo_required",
    });
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
  });

  it("refuses to activate a mandate whose destination token account is frozen", async () => {
    await answerPyusd({ extensions: [], destinationExtensions: [], destinationFrozen: true });
    const created = await createRecurringPaymentFixture({
      ...DEFAULT_RECURRING_FIXTURE,
      token: PYUSD,
    });
    const sendsBefore = sendTransactionMock.mock.calls.length;

    const response = await app.request(
      `/v1/payments/recurring-payments/${created.id}/activate`,
      { method: "POST", headers: RECURRING_HEADERS, body: "{}" },
      env
    );

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(await response.json()).error.details).toMatchObject({
      reason: "destination_frozen",
    });
    expect(sendTransactionMock.mock.calls.length).toBe(sendsBefore);
  });
});
