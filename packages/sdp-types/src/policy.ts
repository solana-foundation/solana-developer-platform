export type PolicyProfileStatus = "draft" | "active" | "disabled" | "archived";
export type PolicyDefaultAction = "allow" | "deny" | "approval_required" | "review";
export type EffectivePolicySource = "implicit_default_allow" | "customer_profile";

export type WalletOperationFamily =
  | "transfer"
  | "payment"
  | "ramp"
  | "issuance"
  | "raw_sign"
  | "program"
  | "provider_admin";

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
  operationType?: string;
  operationTypes?: string[];
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
  operationTypes?: string[];
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
export type ApprovalGroupStatus = "active" | "archived";
export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "canceled"
  | "expired"
  | "failed";

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
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
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

export interface WalletOperationActor {
  type: string;
  id: string | null;
  [key: string]: unknown;
}

export type WalletOperationContext = Record<string, unknown>;
export type WalletOperationProviderExtensions = Record<string, unknown>;

export interface WalletOperationEnvelope {
  id: string;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string | null;
  walletId: string;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  source: string;
  operationFamily: WalletOperationFamily;
  operationType: string;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  context: WalletOperationContext;
  providerExtensions: WalletOperationProviderExtensions;
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
  kind: string;
  decision: PolicyDecision;
  reason: string;
  rule: Record<string, unknown>;
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
  operation: {
    id: string;
    organizationId: string;
    projectId: string | null;
    custodyWalletId: string | null;
    walletId: string;
    apiKeyId: string | null;
    actor: WalletOperationActor | null;
    source: string;
    operationFamily: WalletOperationFamily;
    operationType: string;
    asset: string | null;
    amount: string | null;
    destination: string | null;
    context: WalletOperationContext;
    providerExtensions: WalletOperationProviderExtensions;
    idempotencyKey: string | null;
    rawPayload: Record<string, unknown>;
    createdAt: string;
  };
  walletPolicy: PolicyEvaluationPolicyContext;
  apiKeyPolicy: PolicyEvaluationPolicyContext | null;
}

export interface PolicyEvaluationPolicyContext {
  source: EffectivePolicySource;
  profileId: string | null;
  revisionId: string | null;
  defaultAction: PolicyDefaultAction;
  decision: PolicyDecision;
  requiresApproval: boolean;
}

export interface WalletOperationPolicyEvaluation {
  operation: WalletOperationEnvelope;
  wallet: PolicyScopeEvaluation;
  apiKey: PolicyScopeEvaluation | null;
  decision: PolicyDecision;
  reasonCode: PolicyEvaluationReasonCode | string;
  reason: string;
  matchedRules: MatchedPolicyRule[];
  evaluationContext: PolicyEvaluationContext;
  requiresApproval: boolean;
  walletPolicyRevisionId: string | null;
  apiKeyPolicyRevisionId: string | null;
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
