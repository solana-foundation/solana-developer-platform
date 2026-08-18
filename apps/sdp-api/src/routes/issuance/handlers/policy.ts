import type { PolicyCandidate, Token, WalletOperationType } from "@sdp/types";
import type { ApiKeyContext } from "@/lib/auth";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";

type IssuancePolicyOperationType = Extract<
  WalletOperationType,
  "issuance_mint_execute" | "issuance_update_authority_execute"
>;

/**
 * Build the issuance wallet-operation policy candidate shared by the mint and
 * update-authority policy gates.
 *
 * @param input - The auth context, token, resolved wallet ids, operation type, amount, and destination.
 * @returns The policy candidate for the issuance operation.
 */
export function buildIssuancePolicyCandidate(input: {
  auth: ApiKeyContext;
  token: Token;
  custodyWalletId: string | null;
  walletId: string;
  operationType: IssuancePolicyOperationType;
  amount: string | null;
  destination: string | null;
}): PolicyCandidate {
  return {
    organizationId: input.auth.organizationId,
    projectId: input.token.projectId,
    custodyWalletId: input.custodyWalletId,
    walletId: input.walletId,
    apiKeyId: input.auth.apiKeyId,
    actor: walletOperationActorFromAuth(input.auth),
    source: "api",
    operationFamily: "issuance",
    operationType: input.operationType,
    asset: input.token.symbol,
    amount: input.amount,
    destination: input.destination,
    context: {
      tokenId: input.token.id,
      tokenSymbol: input.token.symbol,
      mintAddress: input.token.mintAddress,
    },
    providerExtensions: {},
  };
}
