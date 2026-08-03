import { getRequestTenantScope } from "@/lib/tenant-scope";
import {
  enforceWalletOperationPolicy,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import type { AppContext } from "../../context";
import type { CreateTransferBatchInput, ResolvedBatchRequest } from "./types";

/**
 * Enforces control-profile policy for a batch as one wallet operation:
 * destination and amount rules evaluate per recipient leg, amount rules also
 * evaluate against the batch total, and the strictest decision wins.
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
  await enforceWalletOperationPolicy(
    c.env,
    getRequestTenantScope(c),
    {
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
    },
    resolved.recipients.map((recipient) => ({
      destination: recipient.destinationAddress,
      amount: recipient.amount,
    }))
  );
}
