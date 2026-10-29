import { createClusterRpc } from "@sdp/rpc/factory";
import { withTransientRpcRetry } from "@sdp/rpc/transient";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError } from "@/lib/errors";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyFingerprintMatches,
  markIdempotencyCommitted,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { admitPaymentStart } from "@/routes/payments/wallets";
import { assertNoSolRentShortfall } from "@/services/payments/sol-rent-minimum";
import {
  type AuthorizedBatchRequest,
  authorizeBatchRequest,
  resolveBatchMovement,
} from "./resolve";
import { buildTransferBatchResponse } from "./respond";
import { prepareBatchChunks, runBatchChunks } from "./run";
import type { createTransferBatchSchema } from "./schemas";
import { solBatchMovement } from "./sol-movement";
import type { CreateTransferBatchInput } from "./types";

async function respondToTransferBatchReplay(
  c: AppContext,
  batch: PaymentTransferBatchRow,
  organizationId: string,
  projectId: string
) {
  const response = await buildTransferBatchResponse(c, batch, organizationId, projectId);
  return success(c, response);
}

/**
 * The key a batch row is recorded under (ADR 0009): its payout run (project,
 * source wallet, externalId), never the request's key, so a resend of the run
 * under any Idempotency-Key finds the same row and pays nobody again
 * (HOO-2335, SDP-021 SA-2).
 */
function transferBatchRunKey(authorized: AuthorizedBatchRequest, externalId: string): string {
  return deriveProviderRequestId(
    [
      "transfer_batch_run",
      authorized.scope.auth.organizationId,
      authorized.projectId,
      authorized.sourceWallet.id,
    ],
    externalId
  );
}

/**
 * Refuses (409, with the batch's id) a row found under a payout run's key
 * unless it is this request's batch: sent by the same credential (a replay
 * goes only to the original credential, ADR 0009) with the same body. Runs
 * before anything is read from the chain or signed.
 */
function assertSamePayoutRun(
  c: AppContext,
  row: PaymentTransferBatchRow,
  authorized: AuthorizedBatchRequest
): void {
  if (
    row.initiated_by_key_id === authorized.scope.auth.id &&
    row.idempotency_fingerprint !== null &&
    idempotencyFingerprintMatches(c, row.idempotency_fingerprint)
  ) {
    return;
  }
  throw new AppError(
    "TRANSFER_BATCH_RUN_EXISTS",
    "A different transfer batch with this externalId already exists for this source wallet. Read it with GET /v1/payments/transfer-batches/{batchId}, and send its failed recipients again with POST /v1/payments/transfer-batches/{batchId}/retry. New recipients go in a new payout run with its own externalId.",
    { batchId: row.id, externalId: row.external_id }
  );
}

/**
 * The batch insert lost on its key index: a concurrent attempt under this row
 * key wrote the row first, either a takeover under the same Idempotency-Key or
 * a send of the same payout run under another one. Answered from that row;
 * nothing was sent. Null when no row holds the key, so the caller rethrows.
 */
async function answerLostBatchInsert(
  c: AppContext,
  authorized: AuthorizedBatchRequest,
  idempotencyKey: string
): Promise<Response | null> {
  const replay = await getPaymentTransferBatchesRepository(c).findTransferBatchByIdempotency({
    organizationId: authorized.scope.auth.organizationId,
    projectId: authorized.projectId,
    idempotencyKey,
  });
  if (replay) {
    assertSamePayoutRun(c, replay, authorized);
    // The batch already existed: marked as a replay, as replayFromRecord
    // marks one, so the client retires its key on it.
    const answered = await respondToTransferBatchReplay(
      c,
      replay,
      authorized.scope.auth.organizationId,
      authorized.projectId
    );
    // Copied, so the header lands on whatever Response the answer built.
    const replayed = new Response(answered.body, answered);
    replayed.headers.set(IDEMPOTENT_REPLAYED_HEADER, "true");
    return replayed;
  }
  return null;
}

/**
 * Settles a run's batch found under another request's key, as far as the chain
 * allows: that request may still be sending, so only recipients whose
 * attempt's lastValidBlockHeight the chain has passed are failed (nothing that
 * attempt built can land). One block-height read; if the RPC can't answer,
 * the batch is answered as it stands and the stranded-batch job settles it.
 */
async function settleExpiredRunAttempt(
  c: AppContext,
  run: PaymentTransferBatchRow
): Promise<PaymentTransferBatchRow> {
  let blockHeight: bigint;
  try {
    blockHeight = await withTransientRpcRetry(() =>
      createClusterRpc().getBlockHeight({ commitment: "confirmed" }).send()
    );
  } catch {
    return run;
  }
  return getPaymentTransferBatchesRepository(c).failUnsentTransferRecipients({
    batchId: run.id,
    organizationId: run.organization_id,
    projectId: run.project_id,
    error: "The batch request ended before this recipient's transfer was sent",
    expiredBelowBlockHeight: blockHeight,
  });
}

/**
 * The create-batch access check (HOO-1918, ADR 0009): source wallet access,
 * read fresh, and every named counterparty account in the project. A replay
 * passes exactly these checks.
 */
export async function authorizeTransferBatch(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedBatchRequest> {
  // SAFETY: mounted after validateBody(createTransferBatchSchema).
  const body = input.body as CreateTransferBatchInput;
  return authorizeBatchRequest(c, body, body.sourceCustodyWalletId);
}

/** The custody runtime takes the source wallet: state, after the replay exits. */
export async function admitTransferBatchExecution(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRequest>
): Promise<void> {
  await admitPaymentStart(c, input.authorized.sourceWallet, "payments.transfer_batch");
}

/**
 * Answers a create-batch request from its row, before admission, so a request
 * that already ran is answered even if its wallet can no longer move money.
 * No RPC and no account state, beyond one block-height read to settle a
 * crashed attempt. Every batch is recorded under its payout run's key
 * (HOO-2335), so the row is found whatever Idempotency-Key the request
 * carries: after a takeover of a crashed attempt, once the shared record has
 * expired, or for a resend of the run under a new key. That row may belong to
 * a request still running under another key, so only recipients the chain
 * proves that request can no longer send are failed (settleExpiredRunAttempt).
 * It is this request's batch only for the same credential and body; any other
 * is 409.
 */
export async function findTransferBatchRecordReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRequest>
): Promise<RecordAnswer | null> {
  const { authorized } = input;
  // SAFETY: mounted after validateBody(createTransferBatchSchema).
  const body = input.body as CreateTransferBatchInput;
  const organizationId = authorized.scope.auth.organizationId;
  const run = await getPaymentTransferBatchesRepository(c).findTransferBatchByIdempotency({
    organizationId,
    projectId: authorized.projectId,
    idempotencyKey: transferBatchRunKey(authorized, body.externalId),
  });
  if (run === null || run.idempotency_fingerprint === null) return null;
  assertSamePayoutRun(c, run, authorized);
  const settled = run.status === "processing" ? await settleExpiredRunAttempt(c, run) : run;
  return {
    fingerprint: run.idempotency_fingerprint,
    respond: () => respondToTransferBatchReplay(c, settled, organizationId, authorized.projectId),
  };
}

/**
 * POST /transfer-batches — creates the batch aggregate with its recipients,
 * then submits its chunks (runBatchChunks) without waiting for on-chain
 * confirmation.
 * Replays idempotently by Idempotency-Key + payload fingerprint. Every batch
 * names its payout run (`externalId`) and is recorded under the run's key
 * (transferBatchRunKey), so findTransferBatchRecordReplay answers a resend of
 * the run under a new key, and the batch's key index lets one of two
 * concurrent sends of the run win.
 *
 * @param c - Request context.
 * @returns JSON batch response with recipients and chunk transfers.
 */
export async function createTransferBatch(
  c: ValidatedBodyContext<typeof createTransferBatchSchema>
) {
  const body = c.req.valid("json");
  const authorized = getAuthorized<AuthorizedBatchRequest>(c);
  const resolved = await resolveBatchMovement(body, authorized);
  // The row's key (the payout run's, never the raw client key) and the key
  // layer's fingerprint, which canonicalizes the batch body.
  const externalId = body.externalId;
  const idempotencyKey = transferBatchRunKey(authorized, externalId);
  const idempotencyFingerprint = getIdempotencyFingerprint(c) ?? null;
  const prepared = await prepareBatchChunks(c, resolved, body.options?.maxRecipientsPerTransaction);
  const { chunks } = prepared;
  // Before the batch row: a refusal is unstored, so the same key runs again once it clears.
  const solMovement = solBatchMovement(resolved, chunks);
  if (solMovement !== null) await assertNoSolRentShortfall(solMovement, "batch");

  let batch: PaymentTransferBatchRow;
  let recipientRows: PaymentTransferRecipientRow[];
  try {
    const created = await createPostgresPaymentTransferBatchesRepository(
      getDb(c.env)
    ).createTransferBatchWithRecipients({
      batch: {
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        externalId,
        sourceCustodyWalletId: resolved.sourceWallet.id,
        sourceWalletId: resolved.sourceWallet.walletId,
        sourceAddress: resolved.sourceAddress,
        token: resolved.tokenContext.token,
        status: "processing",
        totalAmount: resolved.totalAmount,
        recipientCount: resolved.recipients.length,
        transactionCount: chunks.length,
        options: body.options === undefined ? {} : body.options,
        initiatedByKeyId: resolved.scope.auth.id,
        idempotencyKey,
        idempotencyFingerprint,
      },
      recipients: resolved.recipients.map((recipient) => ({
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        externalId: recipient.externalId,
        counterpartyId: recipient.counterpartyId,
        counterpartyAccountId: recipient.counterpartyAccountId,
        destinationAddress: recipient.destinationAddress,
        amount: recipient.amount,
        status: "pending",
        error: null,
        attemptLastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
        attemptId: prepared.attemptId,
      })),
    });
    batch = created.batch;
    recipientRows = created.recipients;
    // The batch row exists under the key: any later answer is stored for its retries.
    markIdempotencyCommitted(c);
  } catch (error) {
    const answered =
      idempotencyKey && isPostgresUniqueViolation(error)
        ? await answerLostBatchInsert(c, authorized, idempotencyKey)
        : null;
    if (answered === null) throw error;
    return answered;
  }
  const finalBatch = await runBatchChunks({
    c,
    resolved,
    batchId: batch.id,
    prepared,
    recipientRows,
    preflight: body.options?.preflight !== false,
  });

  return success(
    c,
    await buildTransferBatchResponse(
      c,
      finalBatch,
      resolved.scope.auth.organizationId,
      resolved.projectId
    )
  );
}
