export type PolicyProfileStatus = "draft" | "active" | "disabled" | "archived";
export type PolicyDefaultAction = "allow" | "deny" | "approval_required" | "review";
export type EffectivePolicySource = "implicit_default_allow" | "customer_profile";

export const WALLET_OPERATION_TYPES = [
  "issuance_burn_execute",
  "issuance_force_burn_execute",
  "issuance_mint_execute",
  "issuance_seize_execute",
  "issuance_update_authority_execute",
  "payment_transfer_batch_execute",
  "payment_transfer_execute",
  "ramp_offramp_quote",
  "ramp_onramp_quote",
  "recurring_payment_collection",
  "recurring_payment_create",
  "recurring_payment_update",
] as const;

export type WalletOperationType = (typeof WALLET_OPERATION_TYPES)[number];

export const WALLET_OPERATION_FAMILIES = ["transfer", "payment", "ramp", "issuance"] as const;

export type WalletOperationFamily = (typeof WALLET_OPERATION_FAMILIES)[number];

export type WalletOperationStatus =
  | "created"
  | "evaluated"
  | "pending_approval"
  | "executing"
  | "completed"
  | "failed"
  | "canceled";

export type PolicyDecision =
  | "allow"
  | "deny"
  | "approval_required"
  | "provider_approval_required"
  | "review"
  | "not_evaluated";

export type PolicyEvaluationReasonCode =
  | "implicit_default_allow"
  | "wallet_policy_match"
  | "api_key_policy_match"
  | "wallet_policy_missing"
  | "api_key_policy_missing"
  | "manual_review"
  | "provider_mapping_pending"
  | "provider_mapping_partial"
  | "provider_mapping_failed";

export type PolicyRuleAction = Exclude<PolicyDecision, "not_evaluated">;
export type PolicyRuleScope = "wallet" | "api_key";

interface PolicyRuleBase {
  id?: string;
  name?: string;
  action?: PolicyRuleAction;
  description?: string;
}

export interface OperationFamilyPolicyRule extends PolicyRuleBase {
  kind: "operation_family";
  family?: WalletOperationFamily;
  families?: WalletOperationFamily[];
}

export interface OperationTypePolicyRule extends PolicyRuleBase {
  kind: "operation_type";
  operationType?: WalletOperationType;
  operationTypes?: WalletOperationType[];
}

export interface AssetPolicyRule extends PolicyRuleBase {
  kind: "asset";
  asset?: string;
  assets?: string[];
}

export interface DestinationPolicyRule extends PolicyRuleBase {
  kind: "destination";
  allowlist?: string[];
  blocklist?: string[];
  destination?: string;
  destinations?: string[];
}

export interface AmountPolicyRule extends PolicyRuleBase {
  kind: "amount";
  min?: string;
  max?: string;
  asset?: string;
  assets?: string[];
}

export interface ApprovalPolicyRule extends PolicyRuleBase {
  kind: "approval";
  families?: WalletOperationFamily[];
  operationTypes?: WalletOperationType[];
  assets?: string[];
  approvalGroupId?: string;
}

export interface AlwaysPolicyRule extends PolicyRuleBase {
  kind: "always";
}

export type PolicyRule =
  | OperationFamilyPolicyRule
  | OperationTypePolicyRule
  | AssetPolicyRule
  | DestinationPolicyRule
  | AmountPolicyRule
  | ApprovalPolicyRule
  | AlwaysPolicyRule;

export type ApiKeyWalletPolicyBindingScope = "all" | "selected";
export type PolicyProviderSyncStatus =
  | "not_applicable"
  | "pending"
  | "synced"
  | "partial"
  | "failed";
export type PolicyControlInventoryTarget = "wallet" | "api_key" | "all";
export type PolicyControlInventoryStatus = "default_allow" | "draft" | "active" | "disabled";
export type ApprovalGroupStatus = "active" | "archived";
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "canceled"
  | "expired"
  | "failed";

/**
 * Historical read model: rows predating a vocabulary trim keep their retired
 * operation family/type strings, so these fields are not narrowed to the live
 * enums.
 */
export interface WalletApprovalRequestOperationSummary {
  id: string;
  custodyWalletId: string | null;
  walletId: string;
  apiKeyId: string | null;
  source: string;
  operationFamily: string;
  operationType: string;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  status: WalletOperationStatus;
  executionStartedAt: string | null;
  executionCompletedAt: string | null;
  executionError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletApprovalRequestPolicyEvaluationSummary {
  id: string;
  decision: PolicyDecision;
  reasonCode: string | null;
  reason: string | null;
  matchedRules: Record<string, unknown>[];
  requiresApproval: boolean;
  evaluatedAt: string;
}

export interface WalletApprovalRequestSummary {
  id: string;
  organizationId: string;
  projectId: string | null;
  walletOperationId: string;
  approvalGroupId: string | null;
  status: ApprovalRequestStatus;
  provider: string | null;
  providerReference: string | null;
  requestedBy: string | null;
  resolvedBy: string | null;
  expiresAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  wallet: {
    custodyWalletId: string;
    walletId: string;
    publicKey: string;
    label: string | null;
  } | null;
  operation: WalletApprovalRequestOperationSummary;
  policyEvaluation: WalletApprovalRequestPolicyEvaluationSummary | null;
}

export interface WalletControlProfile {
  id: string;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string;
  name: string;
  status: PolicyProfileStatus;
  activeRevisionId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
}

export interface WalletControlProfileRevision {
  id: string;
  profileId: string;
  revisionNumber: number;
  rules: PolicyRule[];
  defaultAction: PolicyDefaultAction;
  commitMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface WalletControlProfileRevisionSummary extends WalletControlProfileRevision {
  isActive: boolean;
}

export interface WalletControlProfileRevisionHistory {
  profile: WalletControlProfile | null;
  revisions: WalletControlProfileRevisionSummary[];
}

export interface ApiKeyControlProfile {
  id: string;
  organizationId: string;
  projectId: string | null;
  apiKeyId: string;
  name: string;
  status: PolicyProfileStatus;
  activeRevisionId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
}

export interface ApiKeyControlProfileRevision {
  id: string;
  profileId: string;
  revisionNumber: number;
  rules: PolicyRule[];
  defaultAction: PolicyDefaultAction;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface ApiKeyWalletPolicyBinding {
  id: string;
  apiKeyId: string;
  bindingScope: ApiKeyWalletPolicyBindingScope;
  walletId: string | null;
  custodyWalletId: string | null;
  walletControlProfileId: string | null;
  apiKeyControlProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyControlInventoryLatestEvaluation {
  decision: PolicyDecision;
  evaluatedAt: string;
}

interface PolicyControlInventoryItemBase {
  targetId: string;
  displayName: string;
  controlProfileId: string | null;
  status: PolicyControlInventoryStatus;
  activeRevisionId: string | null;
  activeRevisionNumber: number | null;
  defaultAction: PolicyDefaultAction;
  ruleCount: number;
  updatedAt: string;
  activatedAt: string | null;
  latestEvaluation: PolicyControlInventoryLatestEvaluation | null;
}

export interface WalletPolicyControlInventoryItem extends PolicyControlInventoryItemBase {
  targetType: "wallet";
  walletId: string;
  walletAddress: string;
  providerMappingStatus: PolicyProviderSyncStatus;
}

export interface ApiKeyPolicyControlInventoryItem extends PolicyControlInventoryItemBase {
  targetType: "api_key";
  apiKeyPrefix: string;
  bindingScope: ApiKeyWalletPolicyBindingScope | null;
  selectedWalletCount: number;
}

export type PolicyControlInventoryItem =
  | WalletPolicyControlInventoryItem
  | ApiKeyPolicyControlInventoryItem;

export interface PolicyControlInventorySummary {
  total: number;
  defaultAllow: number;
  draft: number;
  active: number;
  disabled: number;
  totalApiKeyBindings: number;
}

export interface PolicyControlInventoryResponse {
  controls: PolicyControlInventoryItem[];
  total: number;
  page: number;
  pageSize: number;
  summary: PolicyControlInventorySummary;
}

export interface WalletOperationActor {
  type: string;
  id: string | null;
  [key: string]: unknown;
}

export type WalletOperationContext = Record<string, unknown>;
export type WalletOperationProviderExtensions = Record<string, unknown>;

export interface PolicyCandidate {
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string | null;
  walletId: string;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  source: string;
  operationFamily: WalletOperationFamily;
  operationType: WalletOperationType;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  context: WalletOperationContext;
  providerExtensions: WalletOperationProviderExtensions;
}

export interface WalletOperationEnvelope extends PolicyCandidate {
  id: string;
  rawPayload: Record<string, unknown>;
  idempotencyKey: string | null;
  status: WalletOperationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyEvaluation {
  id: string;
  walletOperationId: string;
  walletPolicyRevisionId: string | null;
  apiKeyPolicyRevisionId: string | null;
  decision: PolicyDecision;
  reasonCode: PolicyEvaluationReasonCode | string;
  reason: string | null;
  matchedRules: Record<string, unknown>[];
  evaluationContext: PolicyEvaluationContext | null;
  requiresApproval: boolean;
  approvalRequestId: string | null;
  createdAt: string;
}

export interface MatchedPolicyRule {
  scope: PolicyRuleScope;
  ruleId: string | null;
  kind: PolicyRule["kind"];
  decision: PolicyDecision;
  reason: string;
  rule: PolicyRule;
  /** Zero-based index of the operation leg the rule matched, or null for the operation itself. */
  leg: number | null;
}

export interface PolicyDryRunCriterion {
  scope: PolicyRuleScope;
  ruleId: string | null;
  kind: PolicyRule["kind"];
  name: string | null;
  matched: boolean;
  action: PolicyDecision | null;
  reason: string | null;
  /** Zero-based index of the operation leg the criterion describes, or null for the operation itself. */
  leg: number | null;
}

export interface PolicyDryRunResult {
  decision: PolicyDecision;
  reason: string;
  criteria: PolicyDryRunCriterion[];
  walletPolicyRevisionId: string | null;
  apiKeyPolicyRevisionId: string | null;
}

export interface PolicyScopeEvaluation {
  scope: PolicyRuleScope;
  source: EffectivePolicySource;
  profileId: string | null;
  revisionId: string | null;
  defaultAction: PolicyDefaultAction;
  decision: PolicyDecision;
  reasonCode: PolicyEvaluationReasonCode | string;
  reason: string;
  matchedRules: MatchedPolicyRule[];
  requiresApproval: boolean;
}

export interface PolicyEvaluationContext {
  operation: Omit<WalletOperationEnvelope, "status" | "updatedAt">;
  walletPolicy: PolicyEvaluationPolicyContext;
  apiKeyPolicy: PolicyEvaluationPolicyContext | null;
}

export type PublicPolicyEvaluationContext = Omit<PolicyEvaluationContext, "operation"> & {
  operation: Omit<PolicyEvaluationContext["operation"], "providerExtensions" | "rawPayload">;
};

/**
 * Historical read model: rows predating a vocabulary trim keep their retired
 * operation family/type strings, so these fields are not narrowed to the live
 * enums.
 */
export interface WalletPolicyEvaluationDetail {
  id: string;
  walletOperation: {
    id: string;
    operationFamily: string;
    operationType: string;
    asset: string | null;
    amount: string | null;
    destination: string | null;
    status: WalletOperationStatus;
    createdAt: string;
    updatedAt: string;
  };
  policyRevisions: {
    wallet: {
      evaluatedRevisionId: string | null;
      activeRevisionId: string | null;
    };
    apiKey: {
      evaluatedRevisionId: string | null;
      activeRevisionId: string | null;
    };
  };
  decision: PolicyDecision;
  reasonCode: string;
  reason: string | null;
  matchedRules: Record<string, unknown>[];
  evaluationContext: PublicPolicyEvaluationContext | null;
  requiresApproval: boolean;
  approvalRequestId: string | null;
  evaluatedAt: string;
}

export interface PolicyEvaluationPolicyContext {
  source: EffectivePolicySource;
  profileId: string | null;
  revisionId: string | null;
  defaultAction: PolicyDefaultAction;
  decision: PolicyDecision;
  requiresApproval: boolean;
}

export interface CandidatePolicyEvaluation {
  wallet: PolicyScopeEvaluation;
  apiKey: PolicyScopeEvaluation | null;
  decision: PolicyDecision;
  reasonCode: PolicyEvaluationReasonCode | string;
  reason: string;
  matchedRules: MatchedPolicyRule[];
  requiresApproval: boolean;
  walletPolicyRevisionId: string | null;
  apiKeyPolicyRevisionId: string | null;
}

export interface WalletOperationPolicyEvaluation extends CandidatePolicyEvaluation {
  operation: WalletOperationEnvelope;
  evaluationContext: PolicyEvaluationContext;
}

export interface EffectivePolicy<TProfile, TRevision> {
  source: EffectivePolicySource;
  profile: TProfile | null;
  revision: TRevision | null;
  defaultAction: PolicyDefaultAction;
}

export type EffectiveWalletPolicy = EffectivePolicy<
  WalletControlProfile,
  WalletControlProfileRevision
>;

export type EffectiveApiKeyPolicy = EffectivePolicy<
  ApiKeyControlProfile,
  ApiKeyControlProfileRevision
>;
