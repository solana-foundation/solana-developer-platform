import * as solanaRpc from "@sdp/rpc/solana";
import type { PolicyCandidate } from "@sdp/types";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type {
  PaymentTransferBatchRow,
  PaymentTransferRecipientRow,
} from "@/db/repositories/payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "@/db/repositories/payment-transfer-batches.repository.postgres";
import { AppError, badRequest, internalError } from "@/lib/errors";
import { buildTransferBatchFingerprint } from "@/lib/idempotency";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import * as solanaServices from "@/services/solana";
import { type AppContext, getFeePayment, getPaymentTransferBatchesRepository } from "../../context";
import type { createTransferBatchSchema } from "../../schemas";
import { applyRecipientRowUpdates, executeChunk, updateRecipientRows } from "./execute";
import { resolveBatchRequest } from "./resolve";
import { buildTransferBatchResponse, resolveTransferBatchIdempotencyReplay } from "./respond";
import {
  buildInstructionGroups,
  chunkInstructionGroups,
  DEFAULT_MAX_RECIPIENTS_PER_TRANSACTION,
} from "./transaction";
import type { CreateTransferBatchInput, ResolvedBatchRequest } from "./types";

type TransferBatchResponse = Awaited<ReturnType<typeof buildTransferBatchResponse>>;

interface TransferBatchGateResolved extends ResolvedBatchRequest {
  idempotencyFingerprint: string;
}

async function assertApprovedBatchReplayCompleted(
  c: AppContext,
  response: TransferBatchResponse
): Promise<void> {
  if (!approvedWalletOperationId(c)) {
    return;
  }

  const transfersById = new Map(
    response.transfers.map((transfer) => [transfer.id, transfer] as const)
  );
  const incomplete =
    response.batch.status === "pending" ||
    response.recipients.length !== response.batch.recipientCount ||
    response.recipients.some((recipient) => {
      if (recipient.status === "pending") {
        return true;
      }
      if (recipient.status !== "processing" && recipient.status !== "confirmed") {
        return false;
      }
      return !recipient.transferId || !transfersById.get(recipient.transferId)?.signature;
    });
  if (!incomplete) {
    return;
  }

  // The atomic creation path cannot expose a batch before its approval fence.
  // Fence legacy/inconsistent state before failing so recovery cannot convert
  // a stranded batch into a successful approved operation.
  await beginApprovedWalletOperationEffect(c);
  throw new AppError(
    "CONFLICT",
    "Approved transfer batch is incomplete and requires manual reconciliation"
  );
}

async function respondToTransferBatchReplay(
  c: AppContext,
  batch: PaymentTransferBatchRow,
  organizationId: string,
  projectId: string
) {
  const response = await buildTransferBatchResponse(c, batch, organizationId, projectId);
  await assertApprovedBatchReplayCompleted(c, response);
  return success(c, response);
}

/**
 * Parse and resolve a transfer-batch request into its wallet-operation policy
 * candidate: the batch total as the aggregate candidate plus one leg per
 * recipient, so destination and amount rules evaluate every recipient while
 * amount rules also bind the total.
 *
 * @param c - Request context.
 * @returns The candidate, its legs, validated body, resolved request, and raw payload.
 */
export async function extractTransferBatchPolicyCandidate(
  c: ValidatedBodyContext<typeof createTransferBatchSchema>
): Promise<PolicyGateExtraction> {
  const input = c.req.valid("json");
  const resolved = await resolveBatchRequest(c, input, ["payments:write"]);
  const candidate: PolicyCandidate = {
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.scope.auth.projectId,
    custodyWalletId: resolved.sourceWallet.id,
    walletId: resolved.sourceWallet.walletId,
    apiKeyId: resolved.scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(resolved.scope.auth),
    source: "api",
    operationFamily: "payment",
    operationType: "payment_transfer_batch_execute",
    asset: resolved.tokenContext.token,
    amount: resolved.totalAmount,
    destination: null,
    context: {
      sourceAddress: resolved.sourceAddress,
      recipientCount: resolved.recipients.length,
      transactionCount: null,
    },
    providerExtensions: {},
  };

  return {
    candidate,
    legs: resolved.recipients.map((recipient) => ({
      ...candidate,
      amount: recipient.amount,
      destination: recipient.destinationAddress,
    })),
    body: input,
    resolved: {
      ...resolved,
      idempotencyFingerprint: buildBatchIdempotencyFingerprint(resolved, input.options),
    },
    rawPayload: {
      externalId: input.externalId === undefined ? null : input.externalId,
      source: input.source,
      token: input.token,
      // Resolved destinations ride in the payload so an approved batch pins
      // the exact addresses that were evaluated: a counterparty account whose
      // address changes between approval and replay fails the replay match
      // instead of executing to a destination policy never saw.
      recipients: resolved.recipients.map((recipient) => ({
        externalId: recipient.externalId,
        counterpartyId: recipient.counterpartyId,
        counterpartyAccountId: recipient.counterpartyAccountId,
        destinationAddress: recipient.destinationAddress,
        amount: recipient.amount,
      })),
      options: input.options === undefined ? null : input.options,
    },
    idempotencyKey: null,
  };
}

/**
 * Build the batch idempotency fingerprint from the resolved request.
 *
 * @param resolved - The resolved batch request.
 * @param options - The request's batch options.
 * @returns The fingerprint string.
 */
function buildBatchIdempotencyFingerprint(
  resolved: ResolvedBatchRequest,
  options: CreateTransferBatchInput["options"]
): string {
  return buildTransferBatchFingerprint({
    sourceAddress: resolved.sourceAddress,
    token: resolved.tokenContext.token,
    recipients: resolved.recipients.map((recipient) => ({
      externalId: recipient.externalId,
      counterpartyId: recipient.counterpartyId,
      counterpartyAccountId: recipient.counterpartyAccountId,
      destinationAddress: recipient.destinationAddress,
      amount: recipient.amount,
    })),
    options,
  });
}

/**
 * Resolve an Idempotency-Key replay before transfer-batch policy enforcement.
 *
 * @param c - Request context.
 * @param extraction - The transfer-batch gate extraction.
 * @param idempotencyKey - The Idempotency-Key header value.
 * @returns The recorded batch response, or null for a new request.
 */
export async function findTransferBatchIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const resolved = extraction.resolved as TransferBatchGateResolved;
  const replay = await resolveTransferBatchIdempotencyReplay(
    getPaymentTransferBatchesRepository(c),
    resolved.scope.auth.organizationId,
    resolved.projectId,
    idempotencyKey,
    resolved.idempotencyFingerprint
  );
  if (replay === null) {
    return null;
  }
  return respondToTransferBatchReplay(
    c,
    replay,
    resolved.scope.auth.organizationId,
    resolved.projectId
  );
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
export async function createTransferBatch(c: AppContext) {
  const { body, resolved } = getPolicyGateContext<
    CreateTransferBatchInput,
    TransferBatchGateResolved
  >(c);
  const idempotencyKeyHeader = c.req.header("Idempotency-Key");
  const idempotencyKey = idempotencyKeyHeader === undefined ? null : idempotencyKeyHeader;
  const idempotencyFingerprint = idempotencyKey ? resolved.idempotencyFingerprint : null;

  const feePayment = getFeePayment(c);
  const [signer, feePayer, lifetime] = await Promise.all([
    solanaServices.createOrgSigner(
      c.env,
      resolved.scope.auth.organizationId,
      resolved.projectId,
      resolved.sourceWallet.walletId
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
    const created = await runApprovedWalletOperationEffectTransaction(c, (db) =>
      createPostgresPaymentTransferBatchesRepository(db).createTransferBatchWithRecipients({
        batch: {
          organizationId: resolved.scope.auth.organizationId,
          projectId: resolved.projectId,
          externalId: body.externalId === undefined ? null : body.externalId,
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
      })
    );
    batch = created.batch;
    recipientRows = created.recipients;
  } catch (error) {
    if (idempotencyKey && idempotencyFingerprint && isPostgresUniqueViolation(error)) {
      const replay = await resolveTransferBatchIdempotencyReplay(
        batchRepository,
        resolved.scope.auth.organizationId,
        resolved.projectId,
        idempotencyKey,
        idempotencyFingerprint
      );
      if (replay) {
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
