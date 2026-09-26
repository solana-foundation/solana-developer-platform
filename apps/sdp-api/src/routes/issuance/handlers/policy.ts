import type {
  PolicyCandidate,
  Token,
  WalletOperationContext,
  WalletOperationType,
} from "@sdp/types";
import type { Context } from "hono";
import type { ApiKeyContext } from "@/lib/auth";
import { conflict } from "@/lib/errors";
import { getPolicyGateContext } from "@/middleware/policy-gate";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import type { Env } from "@/types/env";

/**
 * Refuse a custody wallet the gate did not judge. A handler that resolves its
 * signer a second time can land on a different wallet if the authority mapping
 * moved in between, which would execute under a policy nobody evaluated.
 */
export function assertJudgedCustodyWallet(
  c: Context<{ Bindings: Env }>,
  custodyWalletId: string
): void {
  const judged = getPolicyGateContext<unknown, { judgedCustodyWalletId?: string }>(c).resolved
    ?.judgedCustodyWalletId;
  if (judged !== undefined && judged !== custodyWalletId) {
    throw conflict("Signing wallet changed after the operation was evaluated by policy");
  }
}

type IssuancePolicyOperationType = Extract<
  WalletOperationType,
  | "issuance_allowlist_add_execute"
  | "issuance_allowlist_remove_execute"
  | "issuance_burn_execute"
  | "issuance_deploy_execute"
  | "issuance_force_burn_execute"
  | "issuance_freeze_execute"
  | "issuance_metadata_update_execute"
  | "issuance_mint_execute"
  | "issuance_pause_execute"
  | "issuance_seize_execute"
  | "issuance_unfreeze_execute"
  | "issuance_unpause_execute"
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
  /**
   * Asset override for operations whose custody outflow is a different asset
   * than the token itself (APE-831): a metadata update spends signer-paid SOL
   * fees and rent, so its candidate is judged as a SOL operation.
   */
  assetOverride?: string;
  /** Extra context merged under the shared context for auditability. */
  extraContext?: WalletOperationContext;
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
    asset: input.assetOverride ?? input.token.symbol,
    amount: input.amount,
    destination: input.destination,
    context: {
      tokenId: input.token.id,
      tokenSymbol: input.token.symbol,
      mintAddress: input.token.mintAddress,
      ...(input.extraContext ?? {}),
    },
    providerExtensions: {},
  };
}
