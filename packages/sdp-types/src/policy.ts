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
  rules: Record<string, unknown>[];
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
  rules: Record<string, unknown>[];
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

export interface WalletOperationEnvelope {
  id: string;
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string | null;
  walletId: string;
  apiKeyId: string | null;
  source: string;
  operationFamily: WalletOperationFamily;
  operationType: string;
  asset: string | null;
  amount: string | null;
  destination: string | null;
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
  requiresApproval: boolean;
  approvalRequestId: string | null;
  createdAt: string;
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
