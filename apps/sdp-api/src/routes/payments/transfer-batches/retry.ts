import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { conflict, internalError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type AuthorizeInput, getAuthorized } from "@/middleware/authorize";
import type { MovementStepInput } from "@/middleware/movement-steps";
import { type AppContext, getPaymentTransferBatchesRepository } from "@/routes/payments/context";
import { admitPaymentWalletRuntimeExecution } from "@/routes/payments/wallets";
import {
  type AuthorizedBatchRequest,
  authorizeBatchRequest,
  resolveBatchMovement,
} from "./resolve";
import { buildTransferBatchResponse } from "./respond";
import { prepareBatchChunks, runBatchChunks } from "./run";
import { transferBatchOptionsSchema } from "./schemas";
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
    limit: 500,
    offset: 0,
  });
  const authorized = await authorizeBatchRequest(
    c,
    asBatchInput(batch, batch.source_custody_wallet_id, recipients.rows),
    batch.source_custody_wallet_id
  );
  return { ...authorized, batch };
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
 * that claimed one first answers 409 and sends nothing. Each recipient keeps
 * its row and is linked to its new chunk transfer; the failed transfer rows
 * stay as they were. The batch's stored options apply.
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
    limit: 500,
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
  const prepared = await prepareBatchChunks(c, resolved, options.maxRecipientsPerTransaction);
  const claimed = await repository.claimFailedTransferRecipients({
    batchId: batch.id,
    organizationId,
    projectId,
    recipientIds: failed.rows.map((row) => row.id),
    addedTransactionCount: prepared.chunks.length,
  });
  if (claimed === null) {
    throw conflict(
      "Another retry of this transfer batch claimed its failed recipients first. Read the batch, then retry what is still failed.",
      { batchId: batch.id }
    );
  }
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
