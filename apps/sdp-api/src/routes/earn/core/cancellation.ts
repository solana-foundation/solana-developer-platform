import type { OperationTerms } from "@sdp/types/operations";
import { getDb } from "@/db/client";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type {
  OperationRecord,
  PreparedOperationAction,
} from "@/db/repositories/operations.repository";
import { notFound } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";
import { prepareQueuedStrategyCancellation } from "@/services/earn/strategy-queued-operations.service";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { resolveVaultSponsorship } from "@/services/earn/vault-sponsorship";
import { type EarnStrategySource, earnOperationActor, resolveStrategySource } from "./prepare";

export interface AuthorizedEarnOperationCancellation {
  request: EarnVaultWithdrawalRequestRow;
  source: EarnStrategySource;
}

function matchesOperationSource(
  record: OperationRecord,
  binding: { custody_wallet_id?: string | null; owner_address: string }
): boolean {
  return "walletId" in record.source
    ? binding.custody_wallet_id === record.source.walletId
    : binding.custody_wallet_id == null && binding.owner_address === record.source.ownerAddress;
}

async function cancellationRequestId(
  c: AppContext,
  record: OperationRecord,
  includePrepared: boolean
): Promise<string | null> {
  if (record.actionPurpose === "cancel" && !includePrepared) return null;
  const reference = record.operation.resourceRef;
  if (reference?.kind === "earn.withdrawal_request") return reference.id;
  if (record.actionPurpose !== "cancel") return null;
  const build =
    record.operation.buildRef?.kind === "earn.queued_transaction"
      ? await createPostgresEarnVaultWithdrawalRequestsRepository(
          getDb(c.env)
        ).getWalletTransaction({
          organizationId: record.scope.organizationId,
          transactionId: record.operation.buildRef.id,
        })
      : null;
  if (
    build === null ||
    build.project_id !== record.scope.projectId ||
    build.environment !== record.scope.environment ||
    build.action !== "cancel" ||
    !matchesOperationSource(record, build) ||
    build.withdrawal_request_id === null
  )
    throw notFound("Prepared Earn cancellation");
  return build.withdrawal_request_id;
}

/** Check every request/position/source identity before the idempotency waist. */
export async function authorizeEarnOperationCancellation(
  c: AppContext,
  record: OperationRecord,
  options: { includePrepared?: boolean } = {}
): Promise<AuthorizedEarnOperationCancellation | null> {
  const requestId = await cancellationRequestId(c, record, options.includePrepared ?? false);
  if (requestId === null) return null;
  const actor = earnOperationActor(c);
  const request = await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(c.env)).getById({
    organizationId: actor.organizationId,
    environment: actor.environment,
    withdrawalRequestId: requestId,
  });
  if (request === null || request.project_id !== actor.projectId)
    throw notFound("Earn withdrawal request");
  if (!matchesOperationSource(record, request)) throw notFound("Earn withdrawal source");
  const position = await createPostgresEarnMovementsRepository(getDb(c.env)).getPositionById({
    organizationId: actor.organizationId,
    environment: actor.environment,
    positionId: request.position_id,
  });
  if (
    position === null ||
    position.kind !== "vault_direct" ||
    position.provider !== request.provider ||
    position.vault_address !== request.vault_address ||
    position.token_mint !== request.token_mint ||
    position.share_mint !== request.share_mint ||
    position.custody_wallet_id !== request.custody_wallet_id ||
    (position.custody_wallet_id === null &&
      (position.project_id !== actor.projectId || position.owner_address !== request.owner_address))
  ) {
    throw notFound("Earn withdrawal position");
  }
  const source = await resolveStrategySource(c, actor, record.source);
  if (source.ownerAddress !== request.owner_address) throw notFound("Earn withdrawal owner");
  return { request, source };
}

/** Prepare recovery for a new review; cancellation never signs or broadcasts. */
export async function prepareEarnOperationCancellation(
  c: AppContext,
  authorized: AuthorizedEarnOperationCancellation,
  record: OperationRecord
): Promise<PreparedOperationAction> {
  const actor = earnOperationActor(c);
  const { request, source } = authorized;
  const context = {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    userId: actor.auth.userId,
    apiKeyId: actor.auth.apiKeyId,
  };
  const fee =
    source.wallet === null
      ? undefined
      : await resolveVaultSponsorship(c.env, {
          ...context,
          movement: "earn.queued_withdraw_cancel",
          walletId: source.wallet.id,
          deadline: createVaultDeadline(),
        });
  const transaction = await prepareQueuedStrategyCancellation(c.env, {
    actor: context,
    request,
    requestAddress: request.request_address,
    position: {
      id: request.position_id,
      provider: request.provider,
      vaultAddress: request.vault_address,
      tokenMint: request.token_mint,
      shareMint: request.share_mint,
      ownerAddress: source.ownerAddress,
      custodyWalletId: request.custody_wallet_id,
    },
    ...(source.wallet === null
      ? {
          feePayer: record.operation.intent.feePayer,
        }
      : { custodyWalletId: source.wallet.id, fee }),
  });
  const returned =
    request.mechanism === "operator_redemption"
      ? request.intermediate_mint !== null && request.intermediate_amount !== null
        ? { mint: request.intermediate_mint, value: request.intermediate_amount }
        : null
      : { mint: request.share_mint, value: request.shares };
  const terms: OperationTerms = {
    expiresAt: null,
    estimate: returned,
    minimum: null,
    fees: null,
    options: [
      {
        id: "cancel_request",
        label:
          request.mechanism === "operator_redemption"
            ? "Cancel request and retain intermediate tokens"
            : "Cancel request and recover shares",
        settlement: "instant",
        estimatedSeconds: null,
        mechanism: "cancel_request",
        ...(returned === null ? {} : { amount: returned }),
      },
    ],
  };
  return {
    nextAction:
      source.wallet === null
        ? {
            type: "sign_transaction",
            transaction: transaction.unsignedTransaction,
            lastValidBlockHeight: transaction.lastValidBlockHeight,
            expiresAt: null,
          }
        : { type: "submit" },
    terms,
    buildRef: { kind: "earn.queued_transaction", id: transaction.id },
  };
}
