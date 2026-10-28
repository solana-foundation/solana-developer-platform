import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import {
  getIdempotencyFingerprint,
  getIdempotencyRecordKey,
  idempotencyFingerprintMatches,
  markIdempotencyCommitted,
} from "@/middleware/idempotency";
import type { MovementStepInput, RecordAnswer } from "@/middleware/movement-steps";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { admitPaymentWalletRuntimeExecution } from "@/routes/payments/wallets";
import { assertNoSolRentShortfall } from "@/services/payments/sol-rent-minimum";
import {
  type AuthorizedBatchRequest,
  authorizeBatchRequest,
  resolveBatchMovement,
} from "./resolve";
import { buildTransferBatchResponse } from "./respond";
import { prepareBatchChunks, runBatchChunks } from "./run";
import { MAX_TRANSFER_BATCH_RECIPIENTS, transferBatchOptionsSchema } from "./schemas";
import { solBatchMovement } from "./sol-movement";
import type { CreateTransferBatchInput } from "./types";

/** The batch a retry names, and the access check of everything it pays. */
export interface AuthorizedBatchRetry extends AuthorizedBatchRequest {
  batch: PaymentTransferBatchRow;
}

/** The batch's recipients as a create body, for the shared access check and resolve. */
function asBatchInput(
  batch: PaymentTransferBatchRow,
  sourceCustodyWalletId: string,
  recipients: PaymentTransferRecipientRow[]
): CreateTransferBatchInput {
  return {
    sourceCustodyWalletId,
    token: batch.token,
    recipients: recipients.map((recipient) => ({
      externalId: recipient.external_id ?? undefined,
      counterpartyId: recipient.counterparty_id,
      counterpartyAccountId: recipient.counterparty_account_id,
      amount: recipient.amount,
    })),
  };
}

/**
 * The retry access check (HOO-2343, ADR 0009): the batch in the project, and
 * what create checks for it — the source wallet, read fresh, and every
 * recipient's counterparty account. Every recipient, not only the failed ones,
 * since which recipients failed is state. A replay passes exactly these checks.
 */
export async function authorizeTransferBatchRetry(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedBatchRetry> {
  // SAFETY: mounted after validateParams(transferBatchIdParamsSchema).
  const { batchId } = input.params as { batchId: string };
  const organizationId = getAuth(c).organizationId;
  const projectId = requireProjectId(c);
  const repository = getPaymentTransferBatchesRepository(c);
  const batch = await repository.getTransferBatchById({ batchId, organizationId, projectId });
  // A batch whose source wallet was deleted (migration 0096) has nothing to sign with.
  if (!batch || batch.source_custody_wallet_id === null) {
    throw notFound("Transfer batch");
  }
  const recipients = await repository.listTransferRecipientsByBatch({
    batchId,
    organizationId,
    projectId,
    limit: MAX_TRANSFER_BATCH_RECIPIENTS,
    offset: 0,
  });
  const authorized = await authorizeBatchRequest(
    c,
    asBatchInput(batch, batch.source_custody_wallet_id, recipients.rows),
    batch.source_custody_wallet_id
  );
  return { ...authorized, batch };
}

/**
 * Answers a retry from the row its claim recorded under the key (HOO-2343,
 * ADR 0009): a rerun after a 5xx, a takeover of a crashed retry, or a retry of
 * the key once its record expired. Nothing is claimed again. It runs only once
 * the request that claimed is presumed dead (the key layer took the key over,
 * or it expired), so its recipients still pending with no chunk transfer will
 * never be sent: a chunk's transfer row and links commit before its
 * broadcast. They are failed, and the batch settles, before it answers, so
 * they can be retried at once. Only the recipients the row recorded, and only
 * as the claim left them (`updated_at` up to the row's `created_at`): another
 * request may still be sending the batch's other recipients, and a later
 * retry may have claimed these again.
 */
export async function findTransferBatchRetryReplay(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRetry>,
  recordKey: string
): Promise<RecordAnswer | null> {
  const { batch, projectId } = input.authorized;
  const organizationId = input.authorized.scope.auth.organizationId;
  const retry = await getPaymentTransferBatchesRepository(c).findTransferBatchRetryByIdempotency({
    organizationId,
    projectId,
    idempotencyKey: recordKey,
  });
  if (retry === null) return null;
  if (
    retry.batch_id !== batch.id ||
    !idempotencyFingerprintMatches(c, retry.idempotency_fingerprint)
  ) {
    // Another request's retry under this key: the step refuses it (422).
    return { fingerprint: retry.idempotency_fingerprint, respond: () => success(c, {}) };
  }
  const settled =
    batch.status === "processing"
      ? await getPaymentTransferBatchesRepository(c).failUnsentTransferRecipients({
          batchId: batch.id,
          organizationId,
          projectId,
          error: "The retry request ended before this recipient's transfer was sent",
          attemptedBefore: new Date(Date.parse(retry.created_at) + 1).toISOString(),
          // Only what this retry claimed: the create, or another retry, may
          // still be sending other recipients of the batch.
          recipientIds: retry.recipient_ids,
        })
      : batch;
  return {
    fingerprint: retry.idempotency_fingerprint,
    respond: async () =>
      success(c, await buildTransferBatchResponse(c, settled, organizationId, projectId)),
  };
}

/**
 * Refuses (409) a retry whose recipient's counterparty account now holds a
 * different address than the one the batch recorded for it: the retry pays
 * the recorded address or nobody, and the caller decides with the batch in
 * hand. Nothing has been signed.
 */
function assertRecordedDestinations(
  batch: PaymentTransferBatchRow,
  failed: PaymentTransferRecipientRow[],
  resolvedAddresses: string[]
): void {
  const changed = failed.filter(
    (row, index) => row.destination_address !== resolvedAddresses[index]
  );
  if (changed.length === 0) return;
  throw conflict(
    "A failed recipient's counterparty account changed its address since the batch was sent. Nothing was sent; send that recipient in a new batch.",
    { batchId: batch.id, recipientIds: changed.map((row) => row.id) }
  );
}

/** The custody runtime takes the source wallet: state, after the key's replay exits. */
export async function admitTransferBatchRetryExecution(
  c: AppContext,
  input: MovementStepInput<AuthorizedBatchRetry>
): Promise<void> {
  await admitPaymentWalletRuntimeExecution(c, input.authorized.sourceWallet);
}

/**
 * POST /transfer-batches/:batchId/retry — sends a batch's failed recipients
 * again, and no other (HOO-2343, SDP-021 SA-2). A failed recipient was
 * definitely not paid: its chunk never reached the network or the network
 * rejected it. Pending and processing recipients may still land and are never
 * touched. The resend is built first, then the failed recipients are claimed
 * back to pending under the batch lock, all or nothing, so a concurrent retry
 * that claimed one first answers 409 and sends nothing. The claim records the
 * retry under its key in the same transaction, so a rerun is answered from it
 * (findTransferBatchRetryReplay). Each recipient is paid the address the batch
 * recorded for it, or the retry is refused. Each keeps its row and is linked
 * to its new chunk transfer; the failed transfer rows stay as they were. The
 * batch's stored options apply.
 *
 * @param c - Request context.
 * @returns JSON batch response with recipients and chunk transfers.
 */
export async function retryTransferBatch(c: AppContext) {
  const authorized = getAuthorized<AuthorizedBatchRetry>(c);
  const { batch, projectId } = authorized;
  const organizationId = authorized.scope.auth.organizationId;
  const repository = getPaymentTransferBatchesRepository(c);
  const failed = await repository.listTransferRecipientsByBatch({
    batchId: batch.id,
    organizationId,
    projectId,
    status: "failed",
    limit: MAX_TRANSFER_BATCH_RECIPIENTS,
    offset: 0,
  });
  if (failed.rows.length === 0) {
    throw conflict("This transfer batch has no failed recipients to retry", {
      batchId: batch.id,
      status: batch.status,
    });
  }

  const options = transferBatchOptionsSchema.parse(batch.options);
  const resolved = await resolveBatchMovement(
    asBatchInput(batch, authorized.sourceWallet.id, failed.rows),
    authorized
  );
  assertRecordedDestinations(
    batch,
    failed.rows,
    resolved.recipients.map((recipient) => recipient.destinationAddress)
  );
  const prepared = await prepareBatchChunks(c, resolved, options.maxRecipientsPerTransaction);
  // Before the claim: a recipient still below the rent minimum would only fail
  // again, so the retry is refused and its recipients stay failed (HOO-2375).
  const solMovement = solBatchMovement(resolved, prepared.chunks);
  if (solMovement !== null) await assertNoSolRentShortfall(solMovement, "batch");
  const idempotencyKey = getIdempotencyRecordKey(c);
  const idempotencyFingerprint = getIdempotencyFingerprint(c);
  if (idempotencyKey === undefined || idempotencyFingerprint === undefined) {
    throw internalError("Transfer batch retry is missing its Idempotency-Key");
  }
  const claimed = await repository.claimFailedTransferRecipients({
    batchId: batch.id,
    organizationId,
    projectId,
    recipientIds: failed.rows.map((row) => row.id),
    addedTransactionCount: prepared.chunks.length,
    retry: { idempotencyKey, idempotencyFingerprint, initiatedByKeyId: authorized.scope.auth.id },
  });
  if (claimed === null) {
    throw conflict(
      "Another retry of this transfer batch claimed its failed recipients first. Read the batch, then retry what is still failed.",
      { batchId: batch.id }
    );
  }
  // The retry row exists under the key: any later answer is stored for its reruns.
  markIdempotencyCommitted(c);
  const claimedById = new Map(claimed.recipients.map((row) => [row.id, row]));
  const finalBatch = await runBatchChunks({
    c,
    resolved,
    batchId: batch.id,
    prepared,
    recipientRows: failed.rows.map((row) => {
      const claimedRow = claimedById.get(row.id);
      if (!claimedRow) throw internalError("Claimed transfer batch recipient is missing");
      return claimedRow;
    }),
    preflight: options.preflight !== false,
  });

  return success(c, await buildTransferBatchResponse(c, finalBatch, organizationId, projectId));
}
