import type { Token } from "@sdp/types";
import type { ApiKeyContext } from "@/lib/auth";
import {
  enforceWalletOperationPolicy,
  resolvePolicyCustodyWallet,
  walletOperationActorFromAuth,
} from "@/services/policy-enforcement.service";
import type { AppContext } from "../helpers";

type IssuancePolicyOperationType = "issuance_mint_execute" | "issuance_update_authority_execute";

export async function enforceIssuanceWalletOperationPolicy(
  c: AppContext,
  input: {
    auth: ApiKeyContext;
    token: Token;
    walletId: string | null;
    operationType: IssuancePolicyOperationType;
    amount?: string | null;
    destination?: string | null;
    rawPayload?: Record<string, unknown>;
  }
): Promise<void> {
  if (!input.walletId) {
    return;
  }

  const policyWallet = await resolvePolicyCustodyWallet(c.env, input.auth, input.walletId);

  await enforceWalletOperationPolicy(c.env, {
    organizationId: input.auth.organizationId,
    projectId: input.token.projectId,
    custodyWalletId: policyWallet?.id ?? null,
    walletId: input.walletId,
    apiKeyId: input.auth.apiKeyId,
    actor: walletOperationActorFromAuth(input.auth),
    operationFamily: "issuance",
    operationType: input.operationType,
    asset: input.token.symbol,
    amount: input.amount ?? null,
    destination: input.destination ?? null,
    context: {
      tokenId: input.token.id,
      tokenSymbol: input.token.symbol,
      mintAddress: input.token.mintAddress,
    },
    rawPayload: {
      tokenId: input.token.id,
      mintAddress: input.token.mintAddress,
      ...(input.rawPayload ?? {}),
    },
  });
}
