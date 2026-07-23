import { assertWalletPolicyAllowsTransferWithRows } from "@/services/payments/wallet-policy";
import {
  enforceWalletOperationPolicy,
  recordLegacyWalletPolicyDenial,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import { type AppContext, getPaymentsRepository } from "../../context";
import type { CreateTransferBatchInput, ResolvedBatchRequest } from "./types";

/**
 * Enforces wallet-operation and wallet policies for a batch: destination
 * allowlist per recipient and transfer/daily limits against the batch total,
 * with the policy rows fetched once for the whole batch. Denials are recorded
 * before rethrowing.
 *
 * @param c - Request context.
 * @param resolved - Resolved batch request.
 * @param input - Original request body, recorded with the enforcement event.
 */
export async function enforceBatchPolicies(
  c: AppContext,
  resolved: ResolvedBatchRequest,
  input: CreateTransferBatchInput
): Promise<void> {
  const enforcement = await enforceWalletOperationPolicy(c.env, {
    organizationId: resolved.scope.auth.organizationId,
    projectId: resolved.scope.auth.projectId,
    custodyWalletId: resolved.sourceWallet.id,
    walletId: resolved.sourceWallet.walletId,
    apiKeyId: resolved.scope.auth.apiKeyId,
    actor: walletOperationActorFromAuth(resolved.scope.auth),
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
    rawPayload: {
      externalId: input.externalId ?? null,
      source: input.source,
      token: input.token,
      recipients: input.recipients.map((recipient) => ({
        externalId: recipient.externalId ?? null,
        counterpartyId: recipient.counterpartyId,
        counterpartyAccountId: recipient.counterpartyAccountId,
        amount: recipient.amount,
      })),
      options: input.options ?? null,
    },
  });

  try {
    const repository = getPaymentsRepository(c);
    const rows = await repository.getWalletPoliciesByCustodyWalletId(resolved.sourceWallet.id);
    for (const recipient of resolved.recipients) {
      await assertWalletPolicyAllowsTransferWithRows(repository, rows, {
        organizationId: resolved.scope.auth.organizationId,
        projectId: resolved.projectId,
        wallet: resolved.sourceWallet,
        destinationAddress: recipient.destinationAddress,
        enforceDailyLimit: false,
        token: resolved.tokenContext.token,
        amount: recipient.amount,
      });
    }

    await assertWalletPolicyAllowsTransferWithRows(repository, rows, {
      organizationId: resolved.scope.auth.organizationId,
      projectId: resolved.projectId,
      wallet: resolved.sourceWallet,
      destinationAddress: null,
      enforceDestinationAllowlist: false,
      token: resolved.tokenContext.token,
      amount: resolved.totalAmount,
    });
  } catch (error) {
    await recordLegacyWalletPolicyDenial(c.env, enforcement, error);
    throw error;
  }
}
