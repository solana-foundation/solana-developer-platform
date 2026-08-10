import { assertWalletPolicyAllowsTransferWithRows } from "@/services/payments/wallet-policy";
import { type AppContext, getPaymentsRepository } from "../../context";
import type { ResolvedBatchRequest } from "./types";

/**
 * Enforces legacy wallet policies for a batch: destination allowlist per
 * recipient and transfer/daily limits against the batch total, with policy
 * rows fetched once for the whole batch.
 *
 * @param c - Request context.
 * @param resolved - Resolved batch request.
 * @returns A promise that resolves when every legacy wallet policy allows.
 */
export async function assertLegacyBatchPolicies(
  c: AppContext,
  resolved: ResolvedBatchRequest
): Promise<void> {
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
}
