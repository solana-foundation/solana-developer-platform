import { getRecentBlockhash } from "@sdp/rpc/solana";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError, badRequest, conflict, internalError } from "@/lib/errors";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  IDEMPOTENT_REPLAYED_HEADER,
  idempotencyFingerprintMatches,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { admitPaymentWalletRuntimeExecution } from "@/routes/payments/wallets";
import { assertNoSolRentShortfall } from "@/services/payments/sol-rent-minimum";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import {
  createSponsorshipFeePayment,
  resolveRequestSponsorshipScope,
} from "@/services/sponsorship.service";
import { applyRecipientRowUpdates, executeChunk, updateRecipientRows } from "./execute";
import {
  type AuthorizedBatchRequest,
  authorizeBatchRequest,
  resolveBatchMovement,
} from "./resolve";
import { buildTransferBatchResponse } from "./respond";
import type { createTransferBatchSchema } from "./schemas";
import { solBatchMovement } from "./sol-movement";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
} from "./transaction";
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
 * The key a batch row is recorded under (ADR 0009). A batch that names its
 * payout run with `externalId` is recorded under the run (project, source
 * wallet, externalId) rather than the request's key, so a resend of the run
 * under any Idempotency-Key finds the same row and pays nobody again
 * (HOO-2335, SDP-021 SA-2). Without `externalId`, the credential-bound record
 * key.
 */
function transferBatchRowKey(
  authorized: AuthorizedBatchRequest,
  externalId: string | undefined,
  recordKey: string
): string {
  if (externalId === undefined) return recordKey;
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
  throw conflict(
    "A different transfer batch with this externalId already exists for this source wallet. Read it with GET /v1/payments/transfer-batches/{batchId}.",
    { batchId: row.id, externalId: row.external_id }
  );
}

/**
 * The batch insert lost on its key index: a concurrent attempt under this row
 * key wrote the row first, either a takeover under the same Idempotency-Key or
 * a send of the same payout run under another one. Answered from that row;
 * nothing was sent.
 */
async function answerLostBatchInsert(
  c: AppContext,
  error: unknown,
  authorized: AuthorizedBatchRequest,
  idempotencyKey: string | null,
  externalId: string | null
): Promise<Response> {
  if (idempotencyKey && isPostgresUniqueViolation(error)) {
    const replay = await getPaymentTransferBatchesRepository(c).findTransferBatchByIdempotency({
      organizationId: authorized.scope.auth.organizationId,
      projectId: authorized.projectId,
      idempotencyKey,
    });
    if (replay) {
      if (externalId !== null) {
        assertSamePayoutRun(c, replay, authorized);
      } else if (
        replay.idempotency_fingerprint === null ||
        !idempotencyFingerprintMatches(c, replay.idempotency_fingerprint)
      ) {
        // Another request's row: refused unstored, so that request's own retry
        // is still answered from it.
        markIdempotencyRecordMismatch(c);
        throw new AppError("IDEMPOTENCY_KEY_REUSED");
      }
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
  }
  throw error;
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
  await admitPaymentWalletRuntimeExecution(c, input.authorized.sourceWallet);
}

/**
 * Answers a create-batch request from its row, before admission, so a request
 * that already ran is answered even if its wallet can no longer move money.
 * No RPC and no account state.
 *
 * A row under the request's own key is found after a takeover of a crashed
 * attempt, or once the shared record has expired. It runs only once the
 * request that created the batch is presumed dead (the key layer took the key
 * over, or it expired), so recipients still pending with no chunk transfer
 * will never be sent: a chunk's transfer row and links commit before its
 * broadcast. They are failed, and the batch settles, before it answers,
 * instead of replaying a batch stuck in `processing` forever.
 *
 * A row under a payout run's key (`externalId`) may belong to a request still
 * running under another key, so it is answered as it stands and never
 * settled here; the stranded-batch job settles a crashed one. It is this
 * request's batch only for the same credential and body; any other is 409.
 */
export async function findTransferBatchRecordReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRequest>,
  recordKey: string
): Promise<RecordAnswer | null> {
  const { authorized } = input;
  // SAFETY: mounted after validateBody(createTransferBatchSchema).
  const body = input.body as CreateTransferBatchInput;
  const organizationId = authorized.scope.auth.organizationId;
  const repository = getPaymentTransferBatchesRepository(c);
  // The request's own key first: a batch without a run, or one recorded
  // before run keys, keeps its same-key answer and its crash settle.
  const row = await repository.findTransferBatchByIdempotency({
    organizationId,
    projectId: authorized.projectId,
    idempotencyKey: recordKey,
  });
  if (row !== null && row.idempotency_fingerprint !== null) {
    if (!idempotencyFingerprintMatches(c, row.idempotency_fingerprint)) {
      // Another request's row: the step refuses it (422) without touching it.
      return { fingerprint: row.idempotency_fingerprint, respond: () => success(c, {}) };
    }
    const settled =
      row.status === "processing"
        ? await repository.failUnsentTransferRecipients({
            batchId: row.id,
            organizationId,
            projectId: authorized.projectId,
            error: "The batch request ended before this recipient's transfer was sent",
          })
        : row;
    return {
      fingerprint: settled.idempotency_fingerprint,
      respond: () => respondToTransferBatchReplay(c, settled, organizationId, authorized.projectId),
    };
  }
  if (body.externalId === undefined) return null;
  const run = await repository.findTransferBatchByIdempotency({
    organizationId,
    projectId: authorized.projectId,
    idempotencyKey: transferBatchRowKey(authorized, body.externalId, recordKey),
  });
  if (run === null || run.idempotency_fingerprint === null) return null;
  assertSamePayoutRun(c, run, authorized);
  return {
    fingerprint: run.idempotency_fingerprint,
    respond: () => respondToTransferBatchReplay(c, run, organizationId, authorized.projectId),
  };
}

/**
 * POST /transfer-batches — creates the batch aggregate, submits all chunks
 * concurrently, and responds without waiting for on-chain confirmation:
 * transfers come back processing and the pending-transfers job settles them.
 * A chunk whose execution throws is settled as failed recipients rather than
 * failing the request, so sibling submissions are never abandoned half-done.
 * That cleanup only touches recipients still unlinked (transfer_id null):
 * executeChunk creates its transfer row and links recipients in one
 * transaction, so a linked recipient implies a live transfer row that the
 * pending-transfers job settles via settleTransferBatch — unlinking it here
 * would orphan that transfer as permanently processing.
 * The final batch status comes from the locked repository recompute — never
 * from in-memory state — so a reconciliation run that settles chunks during
 * the request cannot be overwritten with a stale status.
 * Replays idempotently by Idempotency-Key + payload fingerprint. A batch that
 * names its payout run (`externalId`) is recorded under the run's key
 * (transferBatchRowKey), so findTransferBatchRecordReplay answers a resend of
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
  // The row's key (the payout run's, or the credential-bound record key; never
  // the raw client key) and the key layer's fingerprint, which canonicalizes
  // the batch body.
  const recordKey = getIdempotencyRecordKey(c);
  const idempotencyKey =
    recordKey === undefined ? null : transferBatchRowKey(authorized, body.externalId, recordKey);
  const idempotencyFingerprint = getIdempotencyFingerprint(c) ?? null;
  const externalId = body.externalId === undefined ? null : body.externalId;

  const feePayment = createSponsorshipFeePayment(
    c.env,
    resolveRequestSponsorshipScope(c),
    "payments.transfer_batch",
    { custodyWalletId: resolved.sourceWallet.id }
  );
  const [signer, feePayer, lifetime] = await Promise.all([
    createOrgSignerForCustodyWallet(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.id,
      "payments.transfer_batch"
    ),
    feePayment.getFeePayer(),
    getRecentBlockhash(resolved.rpc, "confirmed"),
  ]);
  if (signer.address !== resolved.sourceWallet.publicKey) {
    throw badRequest("Resolved signing wallet does not match source wallet");
  }
  const groups = await buildInstructionGroups({
    tokenContext: resolved.tokenContext,
    recipients: resolved.recipients,
    sourceSigner: signer,
    feePayer,
  });
  const chunks = chunkInstructionGroups({
    groups,
    sourceSigner: signer,
    feePayer,
    lifetime,
    maxRecipientsPerTransaction:
      body.options?.maxRecipientsPerTransaction === undefined
        ? DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION
        : body.options.maxRecipientsPerTransaction,
  });

  // Before the batch row: a refusal is unstored, so the same key runs again once it clears.
  const solMovement = solBatchMovement(resolved, chunks);
  if (solMovement !== null) await assertNoSolRentShortfall(solMovement, "batch");

  const batchRepository = getPaymentTransferBatchesRepository(c);
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
      })),
    });
    batch = created.batch;
    recipientRows = created.recipients;
    // The batch row exists under the key: any later answer is stored for its retries.
    markIdempotencyCommitted(c);
  } catch (error) {
    return answerLostBatchInsert(c, error, authorized, idempotencyKey, externalId);
  }
  const recipientsByIndex = new Map<number, PaymentTransferRecipientRow>(
    resolved.recipients.map((recipient, position) => [recipient.index, recipientRows[position]])
  );

  const outcomes = await Promise.allSettled(
    chunks.map((chunk) =>
      executeChunk({
        c,
        resolved,
        chunk,
        recipientsByIndex,
        feePayment,
        lastValidBlockHeight: lifetime.lastValidBlockHeight,
        preflight: body.options?.preflight !== false,
      })
    )
  );
  for (const [position, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      const unlinkedIndexes = chunks[position].recipientIndexes.filter((index) => {
        const row = recipientsByIndex.get(index);
        if (!row) {
          throw internalError("Transfer batch recipient row is missing");
        }
        return row.transfer_id === null;
      });
      if (unlinkedIndexes.length === 0) {
        continue;
      }
      const updates = await updateRecipientRows({
        repository: getPaymentTransferBatchesRepository(c),
        recipientsByIndex,
        recipientIndexes: unlinkedIndexes,
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        transferId: null,
        status: "failed",
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      applyRecipientRowUpdates(recipientsByIndex, updates);
    }
  }

  const finalBatch = await batchRepository.recomputeTransferBatchStatus({
    batchId: batch.id,
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.projectId,
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
