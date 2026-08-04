import type {
  ApprovalRequestStatus,
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  MatchedPolicyRule,
  PolicyDecision,
  PolicyEvaluation,
  PolicyEvaluationContext,
  WalletOperationActor,
  WalletOperationContext,
  WalletOperationEnvelope,
  WalletOperationFamily,
  WalletOperationProviderExtensions,
  WalletOperationStatus,
} from "@sdp/types";

export interface CreateWalletOperationInput {
  organizationId: string;
  projectId: string | null;
  custodyWalletId?: string | null;
  walletId: string;
  apiKeyId?: string | null;
  actor?: WalletOperationActor | null;
  source?: string;
  operationFamily: WalletOperationFamily;
  operationType: string;
  asset?: string | null;
  amount?: string | null;
  destination?: string | null;
  context?: WalletOperationContext;
  providerExtensions?: WalletOperationProviderExtensions;
  rawPayload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  status?: WalletOperationStatus;
}

export interface EffectiveOperationPolicies {
  walletPolicy: EffectiveWalletPolicy;
  apiKeyPolicy: EffectiveApiKeyPolicy | null;
}

export interface CreateApprovalRequestInput {
  organizationId: string;
  projectId: string | null;
  walletOperationId: string;
  approvalGroupId: string | null;
  provider: string | null;
  providerReference: string | null;
  providerPayload: WalletOperationProviderExtensions;
  requestedBy: string | null;
}

export interface RecordPolicyEvaluationInput {
  walletOperationId: string;
  walletPolicyRevisionId: string | null;
  apiKeyPolicyRevisionId: string | null;
  decision: PolicyDecision;
  reasonCode: string;
  reason: string;
  matchedRules: MatchedPolicyRule[];
  evaluationContext: PolicyEvaluationContext;
  requiresApproval: boolean;
  approvalRequestId: string | null;
}

/**
 * Persistence the enforcement flow depends on. Implementations own their
 * failure vocabulary: every method throws on failure rather than returning
 * null, so the flow never second-guesses its store.
 *
 * Wallet-scope and API-key-scope policy resolution meet in
 * {@link loadEffectivePolicies} because an API-key wallet binding can supply
 * the wallet profile as well; the store composes the per-scope lookups.
 */
export interface PolicyEnforcementStore {
  createWalletOperation(input: CreateWalletOperationInput): Promise<WalletOperationEnvelope>;
  loadEffectivePolicies(operation: WalletOperationEnvelope): Promise<EffectiveOperationPolicies>;
  createApprovalRequest(
    input: CreateApprovalRequestInput
  ): Promise<{ id: string; status: ApprovalRequestStatus }>;
  recordPolicyEvaluation(input: RecordPolicyEvaluationInput): Promise<PolicyEvaluation>;
  updateWalletOperationStatus(
    walletOperationId: string,
    status: WalletOperationStatus
  ): Promise<{ status: WalletOperationStatus; updatedAt: string }>;
  failApprovalRequest(operation: WalletOperationEnvelope, approvalRequestId: string): Promise<void>;
}
