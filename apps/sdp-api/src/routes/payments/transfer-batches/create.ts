import * as solanaRpc from "@sdp/rpc/solana";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError, badRequest, internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import type { ValidatedBodyContext } from "@/middleware/validate";
import * as solanaServices from "@/services/solana";
import { type AppContext, getFeePayment, getPaymentTransferBatchesRepository } from "../context";
import { admitPaymentWalletRuntimeExecution, authorizeCustodyPaymentWallet } from "../wallets";
import { applyRecipientRowUpdates, executeChunk, updateRecipientRows } from "./execute";
import {
  type AuthorizedBatchRequest,
  authorizeBatchRequest,
  resolveBatchMovement,
} from "./resolve";
import { buildTransferBatchResponse } from "./respond";
import type { createTransferBatchSchema } from "./schemas";
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
  // Read fresh, never from the cached snapshot, which drops a binding once its
  // wallet is inactive and would refuse the replay of a batch that ran.
  authorizeCustodyPaymentWallet(c, body.sourceCustodyWalletId, ["payments:write"]);
  return authorizeBatchRequest(c, body, null, body.sourceCustodyWalletId);
}

/** The custody runtime takes the source wallet: state, after the replay exits. */
export async function admitTransferBatchExecution(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRequest>
): Promise<void> {
  await admitPaymentWalletRuntimeExecution(c, input.authorized.sourceWallet);
}

/**
 * Answers a create-batch request from its row: after a takeover of a crashed
 * attempt, or once the shared record has expired. No RPC and no account state.
 * It runs only once the request that created the batch is presumed dead (the
 * key layer took the key over, or it expired), so recipients still pending
 * with no chunk transfer will never be sent: a chunk's transfer row and links
 * commit before its broadcast. They are failed, and the batch settles, before
 * it answers, instead of replaying a batch stuck in `processing` forever.
 */
export async function findTransferBatchRecordReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRequest>,
  recordKey: string
): Promise<RecordAnswer | null> {
  const { authorized } = input;
  const organizationId = authorized.scope.auth.organizationId;
  const row = await getPaymentTransferBatchesRepository(c).findTransferBatchByIdempotency({
    organizationId,
    projectId: authorized.projectId,
    idempotencyKey: recordKey,
  });
  if (row === null || row.idempotency_fingerprint === null) return null;
  if (row.idempotency_fingerprint !== getIdempotencyFingerprint(c)) {
    // Another request's row: the step refuses it (422) without touching it.
    return { fingerprint: row.idempotency_fingerprint, respond: () => success(c, {}) };
  }
  const settled =
    row.status === "processing"
      ? await getPaymentTransferBatchesRepository(c).failUnsentTransferRecipients({
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
 * Replays idempotently by Idempotency-Key + payload fingerprint.
 *
 * @param c - Request context.
 * @returns JSON batch response with recipients and chunk transfers.
 */
export async function createTransferBatch(
  c: ValidatedBodyContext<typeof createTransferBatchSchema>
) {
  const body = c.req.valid("json");
  const authorized = getAuthorized<AuthorizedBatchRequest>(c);
  const resolved = await resolveBatchMovement(c, body, authorized);
  // The credential-bound record key (ADR 0009), never the raw client key, and
  // the key layer's fingerprint, which canonicalizes the batch body.
  const idempotencyKey = getIdempotencyRecordKey(c) ?? null;
  const idempotencyFingerprint = getIdempotencyFingerprint(c) ?? null;

  const feePayment = getFeePayment(c, "payments.transfer_batch");
  const [signer, feePayer, lifetime] = await Promise.all([
    solanaServices.createOrgSignerForCustodyWallet(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.id,
      "payments.transfer_batch"
    ),
    feePayment.getFeePayer(),
    solanaRpc.getRecentBlockhash(resolved.rpc, "confirmed"),
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
        externalId: body.externalId === undefined ? null : body.externalId,
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
    if (idempotencyKey && isPostgresUniqueViolation(error)) {
      // A concurrent attempt under this key (a takeover) wrote the row first.
      const replay = await batchRepository.findTransferBatchByIdempotency({
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        idempotencyKey,
      });
      if (replay) {
        if (replay.idempotency_fingerprint !== idempotencyFingerprint) {
          // Another request's row: refused unstored, so that request's own retry
          // is still answered from it.
          markIdempotencyRecordMismatch(c);
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        }
        return respondToTransferBatchReplay(
          c,
          replay,
          resolved.scope.auth.organizationId,
          resolved.projectId
        );
      }
    }
    throw error;
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
