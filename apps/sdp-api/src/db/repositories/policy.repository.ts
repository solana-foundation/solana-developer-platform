import type {
  ApiKeyWalletPolicyBindingScope,
  ApprovalRequestStatus,
  PolicyDecision,
  PolicyDefaultAction,
  PolicyEvaluationContext,
  PolicyProfileStatus,
  PolicyRule,
  WalletOperationActor,
  WalletOperationContext,
  WalletOperationFamily,
  WalletOperationProviderExtensions,
  WalletOperationStatus,
} from "@sdp/types";
import type { RepositoryDbClient } from "./base";

export function generateWalletControlProfileId(): string {
  return `wcp_${crypto.randomUUID()}`;
}

export function generateWalletControlProfileRevisionId(): string {
  return `wcpr_${crypto.randomUUID()}`;
}

export function generateApiKeyControlProfileId(): string {
  return `akcp_${crypto.randomUUID()}`;
}

export function generateApiKeyControlProfileRevisionId(): string {
  return `akcpr_${crypto.randomUUID()}`;
}

export function generateApiKeyWalletPolicyBindingId(): string {
  return `akwpol_${crypto.randomUUID()}`;
}

export function generateWalletOperationId(): string {
  return `wop_${crypto.randomUUID()}`;
}

export function generatePolicyEvaluationId(): string {
  return `peval_${crypto.randomUUID()}`;
}

export function generateApprovalRequestId(): string {
  return `appr_${crypto.randomUUID()}`;
}

export interface WalletControlProfileRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  custody_wallet_id: string;
  name: string;
  status: PolicyProfileStatus;
  active_revision_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  archived_at: string | null;
}

export interface WalletControlProfileRevisionRow {
  id: string;
  profile_id: string;
  revision_number: number;
  rules: Record<string, unknown>[];
  default_action: PolicyDefaultAction;
  created_by: string | null;
  created_at: string;
  activated_at: string | null;
}

export interface ApiKeyControlProfileRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  api_key_id: string;
  name: string;
  status: PolicyProfileStatus;
  active_revision_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  archived_at: string | null;
}

export interface ApiKeyControlProfileRevisionRow {
  id: string;
  profile_id: string;
  revision_number: number;
  rules: Record<string, unknown>[];
  default_action: PolicyDefaultAction;
  created_by: string | null;
  created_at: string;
  activated_at: string | null;
}

export interface ApiKeyWalletPolicyBindingRow {
  id: string;
  api_key_id: string;
  binding_scope: ApiKeyWalletPolicyBindingScope;
  wallet_id: string | null;
  custody_wallet_id: string | null;
  wallet_control_profile_id: string | null;
  api_key_control_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivePolicyProfileRevisionRefRow {
  profile_id: string;
  active_revision_id: string | null;
}

export interface WalletOperationRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  custody_wallet_id: string | null;
  wallet_id: string;
  api_key_id: string | null;
  source: string;
  operation_family: WalletOperationFamily;
  operation_type: string;
  asset: string | null;
  amount: string | null;
  destination: string | null;
  raw_payload: Record<string, unknown>;
  idempotency_key: string | null;
  status: WalletOperationStatus;
  created_at: string;
  updated_at: string;
}

export interface PolicyEvaluationRow {
  id: string;
  wallet_operation_id: string;
  wallet_policy_revision_id: string | null;
  api_key_policy_revision_id: string | null;
  decision: PolicyDecision;
  reason_code: string;
  reason: string | null;
  matched_rules: Record<string, unknown>[];
  evaluation_context: PolicyEvaluationContext | null;
  requires_approval: boolean;
  approval_request_id: string | null;
  created_at: string;
}

export interface ApprovalRequestRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  wallet_operation_id: string;
  approval_group_id: string | null;
  status: ApprovalRequestStatus;
  provider: string | null;
  provider_reference: string | null;
  provider_payload: Record<string, unknown>;
  requested_by: string | null;
  resolved_by: string | null;
  expires_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActiveWalletControlProfileResult {
  profile: WalletControlProfileRow;
  revision: WalletControlProfileRevisionRow | null;
}

export interface ActiveApiKeyControlProfileResult {
  profile: ApiKeyControlProfileRow;
  revision: ApiKeyControlProfileRevisionRow | null;
}

export interface ApiKeyPolicySubjectRow {
  api_key_id: string;
  organization_id: string;
  project_id: string | null;
}

export interface ApiKeyWalletPolicyTargetRow {
  api_key_id: string;
  organization_id: string;
  project_id: string | null;
  wallet_id: string;
  custody_wallet_id: string;
  wallet_project_id: string | null;
  endpoint_binding_count: number;
  endpoint_wallet_binding_id: string | null;
}

export interface ApiKeyWalletPolicyBindingResolutionRow {
  total_binding_count: number;
  binding: ApiKeyWalletPolicyBindingRow | null;
}

export interface CreateWalletControlProfileInput {
  organizationId: string;
  projectId: string | null;
  custodyWalletId: string;
  name: string;
  status?: PolicyProfileStatus;
  createdBy?: string | null;
}

export interface CreateWalletControlProfileRevisionInput {
  profileId: string;
  rules?: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
  createdBy?: string | null;
}

export interface ActivateWalletControlProfileRevisionInput {
  profileId: string;
  revisionId: string;
  activatedAt?: string;
}

export interface CreateApiKeyControlProfileInput {
  organizationId: string;
  projectId: string | null;
  apiKeyId: string;
  name: string;
  status?: PolicyProfileStatus;
  createdBy?: string | null;
}

export interface CreateApiKeyControlProfileRevisionInput {
  profileId: string;
  rules?: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
  createdBy?: string | null;
}

export interface ActivateApiKeyControlProfileRevisionInput {
  profileId: string;
  revisionId: string;
  activatedAt?: string;
}

interface UpsertApiKeyWalletPolicyBindingBaseInput {
  apiKeyId: string;
  walletControlProfileId?: string | null;
  apiKeyControlProfileId?: string | null;
}

export type UpsertApiKeyWalletPolicyBindingInput = UpsertApiKeyWalletPolicyBindingBaseInput &
  (
    | {
        bindingScope: "all";
        walletId?: null;
        custodyWalletId?: null;
      }
    | {
        bindingScope: "selected";
        walletId: string;
        custodyWalletId?: string | null;
      }
  );

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

export interface CreatePolicyEvaluationInput {
  walletOperationId: string;
  walletPolicyRevisionId?: string | null;
  apiKeyPolicyRevisionId?: string | null;
  decision: PolicyDecision;
  reasonCode: string;
  reason?: string | null;
  matchedRules?: Record<string, unknown>[];
  evaluationContext: PolicyEvaluationContext;
  requiresApproval?: boolean;
  approvalRequestId?: string | null;
}

export interface CreateApprovalRequestInput {
  organizationId: string;
  projectId: string | null;
  walletOperationId: string;
  approvalGroupId?: string | null;
  provider?: string | null;
  providerReference?: string | null;
  providerPayload?: Record<string, unknown>;
  requestedBy?: string | null;
  expiresAt?: string | null;
}

export interface UpdateApprovalRequestStatusInput {
  organizationId: string;
  approvalRequestId: string;
  status: ApprovalRequestStatus;
  operationStatus?: WalletOperationStatus;
  resolvedBy?: string | null;
  resolvedAt?: string;
}

export interface PolicyRepositoryContext {
  db: RepositoryDbClient;
}

export interface PolicyRepository {
  createWalletControlProfile(
    input: CreateWalletControlProfileInput
  ): Promise<WalletControlProfileRow | null>;
  createWalletControlProfileRevision(
    input: CreateWalletControlProfileRevisionInput
  ): Promise<WalletControlProfileRevisionRow | null>;
  activateWalletControlProfileRevision(
    input: ActivateWalletControlProfileRevisionInput
  ): Promise<ActiveWalletControlProfileResult | null>;
  getActiveWalletControlProfileByCustodyWalletId(
    custodyWalletId: string
  ): Promise<ActiveWalletControlProfileResult | null>;
  getActiveWalletControlProfileByProfileId(
    profileId: string
  ): Promise<ActiveWalletControlProfileResult | null>;

  createApiKeyControlProfile(
    input: CreateApiKeyControlProfileInput
  ): Promise<ApiKeyControlProfileRow | null>;
  createApiKeyControlProfileRevision(
    input: CreateApiKeyControlProfileRevisionInput
  ): Promise<ApiKeyControlProfileRevisionRow | null>;
  activateApiKeyControlProfileRevision(
    input: ActivateApiKeyControlProfileRevisionInput
  ): Promise<ActiveApiKeyControlProfileResult | null>;
  getActiveApiKeyControlProfileByApiKeyId(
    apiKeyId: string
  ): Promise<ActiveApiKeyControlProfileResult | null>;
  getActiveApiKeyControlProfileByProfileId(
    profileId: string
  ): Promise<ActiveApiKeyControlProfileResult | null>;
  getApiKeyPolicySubject(apiKeyId: string): Promise<ApiKeyPolicySubjectRow | null>;

  upsertApiKeyWalletPolicyBinding(
    input: UpsertApiKeyWalletPolicyBindingInput
  ): Promise<ApiKeyWalletPolicyBindingRow | null>;
  listApiKeyWalletPolicyBindings(apiKeyId: string): Promise<ApiKeyWalletPolicyBindingRow[]>;
  listApiKeyWalletPolicyBindingsForApiKeys(
    apiKeyIds: string[]
  ): Promise<ApiKeyWalletPolicyBindingRow[]>;
  listActiveWalletControlProfileRevisionRefs(
    profileIds: string[]
  ): Promise<ActivePolicyProfileRevisionRefRow[]>;
  listActiveApiKeyControlProfileRevisionRefs(
    profileIds: string[]
  ): Promise<ActivePolicyProfileRevisionRefRow[]>;
  getApiKeyWalletPolicyBindingResolution(
    apiKeyId: string,
    walletId: string
  ): Promise<ApiKeyWalletPolicyBindingResolutionRow>;
  getApiKeyWalletPolicyTarget(
    apiKeyId: string,
    walletId: string
  ): Promise<ApiKeyWalletPolicyTargetRow | null>;

  createWalletOperation(input: CreateWalletOperationInput): Promise<WalletOperationRow | null>;
  getWalletOperationById(walletOperationId: string): Promise<WalletOperationRow | null>;
  updateWalletOperationStatus(
    walletOperationId: string,
    status: WalletOperationStatus
  ): Promise<WalletOperationRow | null>;
  createPolicyEvaluation(input: CreatePolicyEvaluationInput): Promise<PolicyEvaluationRow | null>;
  listPolicyEvaluationsForOperation(walletOperationId: string): Promise<PolicyEvaluationRow[]>;
  createApprovalRequest(input: CreateApprovalRequestInput): Promise<ApprovalRequestRow | null>;
  updateApprovalRequestStatus(
    input: UpdateApprovalRequestStatusInput
  ): Promise<ApprovalRequestRow | null>;
}
