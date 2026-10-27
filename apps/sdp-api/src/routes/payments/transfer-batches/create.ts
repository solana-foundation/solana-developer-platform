import { getRecentBlockhash } from "@sdp/rpc/solana";
import { getDb } from "@/db/client";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import {
  createPostgresPaymentTransferBatchesRepository,
  transferBatchUniqueViolation,
} from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError, badRequest, conflict, internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  idempotencyFingerprintMatches,
  markIdempotencyCommitted,
  markIdempotencyRecordMismatch,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { admitPaymentWalletRuntimeExecution } from "@/routes/payments/wallets";
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

interface BatchWalletScope {
  organizationId: string;
  projectId: string;
  sourceCustodyWalletId: string;
  /** The credential sending the batch, which a held batch replays only to. */
  principalId: string;
}

function findExternalIdHolder(c: AppContext, scope: BatchWalletScope, externalId: string) {
  return getPaymentTransferBatchesRepository(c).findTransferBatchByExternalId({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    sourceCustodyWalletId: scope.sourceCustodyWalletId,
    externalId,
  });
}

/**
 * A payout run's externalId already names a batch on this source wallet
 * (HOO-2335, SDP-021 SA-2), so this request never pays anyone. The same
 * request from the credential that sent the batch, under a new
 * Idempotency-Key, is answered with that batch as it stands; a different
 * request, or another credential, is refused (409) with the batch's id.
 */
async function answerHeldExternalId(
  c: AppContext,
  holder: PaymentTransferBatchRow,
  scope: BatchWalletScope
) {
  if (
    holder.initiated_by_key_id === scope.principalId &&
    holder.idempotency_fingerprint !== null &&
    idempotencyFingerprintMatches(c, holder.idempotency_fingerprint)
  ) {
    return respondToTransferBatchReplay(c, holder, scope.organizationId, scope.projectId);
  }
  throw conflict(
    "A different transfer batch with this externalId already exists for this source wallet. Read it with GET /v1/payments/transfer-batches/{batchId} and send only its failed recipients in a new batch with a new externalId.",
    { batchId: holder.id, externalId: holder.external_id }
  );
}

/**
 * The batch insert lost on a unique index. A concurrent attempt under this
 * request's key (a takeover) wrote its row first and can trip either index:
 * the request answers from that row. A batch of another request that took the
 * externalId after the early check answers as a held externalId. Nothing was
 * sent.
 */
async function answerLostBatchInsert(
  c: AppContext,
  error: unknown,
  scope: BatchWalletScope,
  idempotencyKey: string | null,
  externalId: string | null
) {
  const violation = transferBatchUniqueViolation(error);
  if (idempotencyKey && violation !== null) {
    const replay = await getPaymentTransferBatchesRepository(c).findTransferBatchByIdempotency({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      idempotencyKey,
    });
    if (replay) {
      if (
        replay.idempotency_fingerprint === null ||
        !idempotencyFingerprintMatches(c, replay.idempotency_fingerprint)
      ) {
        // Another request's row: refused unstored, so that request's own retry
        // is still answered from it.
        markIdempotencyRecordMismatch(c);
        throw new AppError("IDEMPOTENCY_KEY_REUSED");
      }
      return respondToTransferBatchReplay(c, replay, scope.organizationId, scope.projectId);
    }
  }
  if (violation === "external_id" && externalId !== null) {
    const holder = await findExternalIdHolder(c, scope, externalId);
    if (holder) return answerHeldExternalId(c, holder, scope);
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
  if (!idempotencyFingerprintMatches(c, row.idempotency_fingerprint)) {
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
 * Replays idempotently by Idempotency-Key + payload fingerprint. An
 * externalId another batch on the source wallet holds replays that batch to
 * the same request from its credential, or refuses (409), before it reads the
 * chain or loads a signer; the unique index catches a race.
 *
 * @param c - Request context.
 * @returns JSON batch response with recipients and chunk transfers.
 */
export async function createTransferBatch(
  c: ValidatedBodyContext<typeof createTransferBatchSchema>
) {
  const body = c.req.valid("json");
  const authorized = getAuthorized<AuthorizedBatchRequest>(c);
  // The credential-bound record key (ADR 0009), never the raw client key, and
  // the key layer's fingerprint, which canonicalizes the batch body.
  const idempotencyKey = getIdempotencyRecordKey(c) ?? null;
  const idempotencyFingerprint = getIdempotencyFingerprint(c) ?? null;
  const externalId = body.externalId === undefined ? null : body.externalId;
  const walletScope: BatchWalletScope = {
    organizationId: authorized.scope.auth.organizationId,
    projectId: authorized.projectId,
    sourceCustodyWalletId: authorized.sourceWallet.id,
    principalId: authorized.scope.auth.id,
  };
  if (externalId !== null) {
    const holder = await findExternalIdHolder(c, walletScope, externalId);
    // A row under this request's own key is a takeover's: the insert answers it.
    if (holder !== null && holder.idempotency_key !== idempotencyKey) {
      return answerHeldExternalId(c, holder, walletScope);
    }
  }
  const resolved = await resolveBatchMovement(body, authorized);

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
    return answerLostBatchInsert(c, error, walletScope, idempotencyKey, externalId);
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
