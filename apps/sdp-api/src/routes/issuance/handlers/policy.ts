import type { PolicyCandidate, Token, WalletOperationType } from "@sdp/types";
import type { TransactionSigner } from "@solana/kit";
import type { ApiKeyContext } from "@/lib/auth";
import { conflict } from "@/lib/errors";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";

/**
 * Refuse a signer the gate did not judge.
 *
 * An extractor names the wallet policy is evaluated against, but a handler that
 * asks for its signer by anything less specific re-runs custody resolution, and
 * the custody target can move in between. Comparing addresses turns that race
 * into a refusal instead of a transaction signed by an unjudged wallet.
 */
export function assertSignerMatchesJudgedWallet(
  signer: TransactionSigner,
  judgedWalletPublicKey: string | null
): void {
  if (judgedWalletPublicKey !== null && signer.address !== judgedWalletPublicKey) {
    throw conflict("Signing wallet changed after the operation was evaluated by policy");
  }
}

type IssuancePolicyOperationType = Extract<
  WalletOperationType,
  | "issuance_burn_execute"
  | "issuance_force_burn_execute"
  | "issuance_mint_execute"
  | "issuance_seize_execute"
  | "issuance_update_authority_execute"
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
