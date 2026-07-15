import type { AppDb, DatabaseExecutor } from "@/db";
import {
  asPostgresJsonArray,
  asPostgresJsonObject,
  parseOptionalPostgresJson,
} from "@/db/postgres-utils";
import { badRequest } from "@/lib/errors";
import type {
  ActivateApiKeyControlProfileRevisionInput,
  ActivateWalletControlProfileRevisionInput,
  ActivePolicyProfileRevisionRefRow,
  ApiKeyControlProfileRevisionRow,
  ApiKeyControlProfileRow,
  ApiKeyPolicySubjectRow,
  ApiKeyWalletPolicyBindingResolutionRow,
  ApiKeyWalletPolicyBindingRow,
  ApiKeyWalletPolicyTargetRow,
  ApprovalRequestDetailRow,
  ApprovalRequestRow,
  CreateApiKeyControlProfileInput,
  CreateApiKeyControlProfileRevisionInput,
  CreateApprovalRequestInput,
  CreatePolicyEvaluationInput,
  CreateWalletControlProfileInput,
  CreateWalletControlProfileRevisionInput,
  CreateWalletOperationInput,
  GetApprovalRequestDetailInput,
  GetWalletControlProfileRevisionHistoryInput,
  GetWalletPolicyEvaluationAuditInput,
  ListApprovalRequestDetailsInput,
  ListPolicyControlInventoryInput,
  ListWalletPolicyEvaluationAuditsInput,
  PolicyControlInventoryRow,
  PolicyEvaluationRow,
  PolicyRepository,
  ReplaceApiKeyWalletPolicyBindingsInput,
  UpdateApprovalRequestStatusInput,
  UpsertApiKeyWalletPolicyBindingInput,
  WalletControlProfileRevisionRow,
  WalletControlProfileRow,
  WalletOperationRow,
  WalletPolicyEvaluationAuditRow,
} from "./policy.repository";

import {
  generateApiKeyControlProfileId,
  generateApiKeyControlProfileRevisionId,
  generateApiKeyWalletPolicyBindingId,
  generateApprovalRequestId,
  generatePolicyEvaluationId,
  generateWalletControlProfileId,
  generateWalletControlProfileRevisionId,
  generateWalletOperationId,
} from "./policy.repository";

const WALLET_CONTROL_PROFILE_REVISION_HISTORY_LIMIT = 100;

const POLICY_CONTROL_INVENTORY_CTE = `
WITH scope AS (
  SELECT ?::text AS organization_id, ?::text AS project_id, ?::text[] AS wallet_ids
),
wallet_targets AS (
  SELECT
    w.id AS target_id,
    w.wallet_id,
    COALESCE(NULLIF(w.label, ''), w.wallet_id) AS display_name,
    w.public_key AS wallet_address,
    c.provider,
    COALESCE(w.updated_at, w.created_at) AS target_updated_at
  FROM custody_wallets w
  INNER JOIN custody_configs c ON c.id = w.custody_config_id
  INNER JOIN scope s
    ON c.organization_id = s.organization_id
   AND c.project_id IS NOT DISTINCT FROM s.project_id
  WHERE c.status = 'active'
    AND w.status = 'active'
    AND (s.wallet_ids IS NULL OR w.wallet_id = ANY(s.wallet_ids))
),
api_key_targets AS (
  SELECT
    ak.id AS target_id,
    ak.name AS display_name,
    ak.key_prefix AS api_key_prefix,
    TO_CHAR(
      ak.created_at::timestamp AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS target_updated_at
  FROM api_keys ak
  INNER JOIN scope s
    ON ak.organization_id = s.organization_id
   AND ak.project_id IS NOT DISTINCT FROM s.project_id
  WHERE ak.status NOT IN ('revoked', 'deactivated')
),
wallet_profile_candidates AS (
  SELECT
    p.id,
    p.custody_wallet_id,
    p.status,
    p.active_revision_id,
    p.updated_at,
    p.activated_at,
    revision.id AS revision_id,
    revision.revision_number,
    revision.default_action,
    revision.rules,
    ROW_NUMBER() OVER (
      PARTITION BY p.custody_wallet_id
      ORDER BY
        CASE p.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        p.updated_at DESC,
        p.id DESC
    ) AS profile_rank
  FROM wallet_control_profiles p
  INNER JOIN scope s
    ON p.organization_id = s.organization_id
   AND p.project_id IS NOT DISTINCT FROM s.project_id
  LEFT JOIN LATERAL (
    SELECT r.id, r.revision_number, r.default_action, r.rules
    FROM wallet_control_profile_revisions r
    WHERE r.profile_id = p.id
    ORDER BY CASE WHEN r.id = p.active_revision_id THEN 0 ELSE 1 END, r.revision_number DESC
    LIMIT 1
  ) revision ON TRUE
  WHERE p.status <> 'archived'
),
wallet_profiles AS (
  SELECT * FROM wallet_profile_candidates WHERE profile_rank = 1
),
api_key_profile_candidates AS (
  SELECT
    p.id,
    p.api_key_id,
    p.status,
    p.active_revision_id,
    p.updated_at,
    p.activated_at,
    revision.id AS revision_id,
    revision.revision_number,
    revision.default_action,
    revision.rules,
    ROW_NUMBER() OVER (
      PARTITION BY p.api_key_id
      ORDER BY
        CASE p.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        p.updated_at DESC,
        p.id DESC
    ) AS profile_rank
  FROM api_key_control_profiles p
  INNER JOIN scope s
    ON p.organization_id = s.organization_id
   AND p.project_id IS NOT DISTINCT FROM s.project_id
  LEFT JOIN LATERAL (
    SELECT r.id, r.revision_number, r.default_action, r.rules
    FROM api_key_control_profile_revisions r
    WHERE r.profile_id = p.id
    ORDER BY CASE WHEN r.id = p.active_revision_id THEN 0 ELSE 1 END, r.revision_number DESC
    LIMIT 1
  ) revision ON TRUE
  WHERE p.status <> 'archived'
),
api_key_profiles AS (
  SELECT * FROM api_key_profile_candidates WHERE profile_rank = 1
),
api_key_binding_aggregates AS (
  SELECT
    b.api_key_id,
    BOOL_OR(b.binding_scope = 'all') AS has_all_scope,
    COUNT(DISTINCT b.wallet_id) FILTER (WHERE b.binding_scope = 'selected') AS selected_wallet_count,
    COUNT(*) AS binding_count
  FROM api_key_wallet_policy_bindings b
  INNER JOIN api_key_targets target ON target.target_id = b.api_key_id
  GROUP BY b.api_key_id
),
wallet_evaluations AS (
  SELECT
    target.target_id,
    pe.decision,
    pe.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY target.target_id
      ORDER BY pe.created_at DESC, pe.id DESC
    ) AS evaluation_rank
  FROM wallet_targets target
  INNER JOIN scope s ON TRUE
  INNER JOIN wallet_operations operation
    ON operation.organization_id = s.organization_id
   AND operation.project_id IS NOT DISTINCT FROM s.project_id
   AND (
     operation.custody_wallet_id = target.target_id
     OR (operation.custody_wallet_id IS NULL AND operation.wallet_id = target.wallet_id)
   )
  INNER JOIN policy_evaluations pe ON pe.wallet_operation_id = operation.id
),
api_key_evaluations AS (
  SELECT
    target.target_id,
    pe.decision,
    pe.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY target.target_id
      ORDER BY pe.created_at DESC, pe.id DESC
    ) AS evaluation_rank
  FROM api_key_targets target
  INNER JOIN scope s ON TRUE
  INNER JOIN wallet_operations operation
    ON operation.organization_id = s.organization_id
   AND operation.project_id IS NOT DISTINCT FROM s.project_id
   AND operation.api_key_id = target.target_id
  INNER JOIN policy_evaluations pe ON pe.wallet_operation_id = operation.id
),
inventory AS (
  SELECT
    'wallet'::text AS target_type,
    target.target_id,
    target.wallet_id,
    target.display_name,
    target.wallet_address,
    NULL::text AS api_key_prefix,
    profile.id AS control_profile_id,
    COALESCE(profile.status, 'default_allow') AS status,
    profile.active_revision_id,
    CASE
      WHEN profile.revision_id = profile.active_revision_id THEN profile.revision_number
      ELSE NULL
    END AS active_revision_number,
    COALESCE(profile.default_action, 'allow') AS default_action,
    COALESCE(JSONB_ARRAY_LENGTH(profile.rules), 0) AS rule_count,
    COALESCE(profile.updated_at, target.target_updated_at) AS updated_at,
    profile.activated_at,
    COALESCE(provider_status.status, 'not_applicable') AS provider_mapping_status,
    NULL::text AS binding_scope,
    NULL::integer AS selected_wallet_count,
    0::bigint AS api_key_binding_count,
    evaluation.decision AS latest_evaluation_decision,
    evaluation.created_at AS latest_evaluation_at
  FROM wallet_targets target
  LEFT JOIN wallet_profiles profile ON profile.custody_wallet_id = target.target_id
  LEFT JOIN policy_provider_sync_status provider_status
    ON provider_status.wallet_control_profile_revision_id = profile.active_revision_id
   AND provider_status.provider = target.provider
  LEFT JOIN wallet_evaluations evaluation
    ON evaluation.target_id = target.target_id
   AND evaluation.evaluation_rank = 1

  UNION ALL

  SELECT
    'api_key'::text AS target_type,
    target.target_id,
    NULL::text AS wallet_id,
    target.display_name,
    NULL::text AS wallet_address,
    target.api_key_prefix,
    profile.id AS control_profile_id,
    COALESCE(profile.status, 'default_allow') AS status,
    profile.active_revision_id,
    CASE
      WHEN profile.revision_id = profile.active_revision_id THEN profile.revision_number
      ELSE NULL
    END AS active_revision_number,
    COALESCE(profile.default_action, 'allow') AS default_action,
    COALESCE(JSONB_ARRAY_LENGTH(profile.rules), 0) AS rule_count,
    COALESCE(profile.updated_at, target.target_updated_at) AS updated_at,
    profile.activated_at,
    NULL::text AS provider_mapping_status,
    CASE
      WHEN COALESCE(bindings.has_all_scope, false) THEN 'all'
      WHEN COALESCE(bindings.selected_wallet_count, 0) > 0 THEN 'selected'
      ELSE NULL::text
    END AS binding_scope,
    COALESCE(bindings.selected_wallet_count, 0)::integer AS selected_wallet_count,
    COALESCE(bindings.binding_count, 0) AS api_key_binding_count,
    evaluation.decision AS latest_evaluation_decision,
    evaluation.created_at AS latest_evaluation_at
  FROM api_key_targets target
  LEFT JOIN api_key_profiles profile ON profile.api_key_id = target.target_id
  LEFT JOIN api_key_binding_aggregates bindings ON bindings.api_key_id = target.target_id
  LEFT JOIN api_key_evaluations evaluation
    ON evaluation.target_id = target.target_id
   AND evaluation.evaluation_rank = 1
)
`;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function policyControlInventoryFilters(
  input: ListPolicyControlInventoryInput,
  includeStatus: boolean
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.target && input.target !== "all") {
    conditions.push("inventory.target_type = ?");
    params.push(input.target);
  }

  const query = input.query?.trim();
  if (query) {
    conditions.push("inventory.display_name ILIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(query)}%`);
  }

  if (includeStatus && input.status) {
    conditions.push("inventory.status = ?");
    params.push(input.status);
  }

  return { conditions, params };
}

function mapPolicyControlInventoryRow(row: Record<string, unknown>): PolicyControlInventoryRow {
  return {
    target_type: row.target_type as PolicyControlInventoryRow["target_type"],
    target_id: row.target_id as string,
    wallet_id: (row.wallet_id as string | null | undefined) ?? null,
    display_name: row.display_name as string,
    wallet_address: (row.wallet_address as string | null | undefined) ?? null,
    api_key_prefix: (row.api_key_prefix as string | null | undefined) ?? null,
    control_profile_id: (row.control_profile_id as string | null | undefined) ?? null,
    status: row.status as PolicyControlInventoryRow["status"],
    active_revision_id: (row.active_revision_id as string | null | undefined) ?? null,
    active_revision_number:
      row.active_revision_number === null || row.active_revision_number === undefined
        ? null
        : Number(row.active_revision_number),
    default_action: row.default_action as PolicyControlInventoryRow["default_action"],
    rule_count: Number(row.rule_count ?? 0),
    updated_at: row.updated_at as string,
    activated_at: (row.activated_at as string | null | undefined) ?? null,
    provider_mapping_status:
      (row.provider_mapping_status as
        | PolicyControlInventoryRow["provider_mapping_status"]
        | undefined) ?? null,
    binding_scope:
      (row.binding_scope as PolicyControlInventoryRow["binding_scope"] | undefined) ?? null,
    selected_wallet_count:
      row.selected_wallet_count === null || row.selected_wallet_count === undefined
        ? null
        : Number(row.selected_wallet_count),
    latest_evaluation_decision:
      (row.latest_evaluation_decision as
        | PolicyControlInventoryRow["latest_evaluation_decision"]
        | undefined) ?? null,
    latest_evaluation_at: (row.latest_evaluation_at as string | null | undefined) ?? null,
  };
}

function mapWalletControlProfileRow(row: Record<string, unknown>): WalletControlProfileRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    custody_wallet_id: row.custody_wallet_id as string,
    name: row.name as string,
    status: row.status as WalletControlProfileRow["status"],
    active_revision_id: (row.active_revision_id as string | null | undefined) ?? null,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    activated_at: (row.activated_at as string | null | undefined) ?? null,
    archived_at: (row.archived_at as string | null | undefined) ?? null,
  };
}

function mapWalletControlProfileRevisionRow(
  row: Record<string, unknown>
): WalletControlProfileRevisionRow {
  return {
    id: row.id as string,
    profile_id: row.profile_id as string,
    revision_number: row.revision_number as number,
    rules: asPostgresJsonArray(row.rules),
    default_action: row.default_action as WalletControlProfileRevisionRow["default_action"],
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    activated_at: (row.activated_at as string | null | undefined) ?? null,
  };
}

function mapApiKeyControlProfileRow(row: Record<string, unknown>): ApiKeyControlProfileRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    api_key_id: row.api_key_id as string,
    name: row.name as string,
    status: row.status as ApiKeyControlProfileRow["status"],
    active_revision_id: (row.active_revision_id as string | null | undefined) ?? null,
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    activated_at: (row.activated_at as string | null | undefined) ?? null,
    archived_at: (row.archived_at as string | null | undefined) ?? null,
  };
}

function mapApiKeyControlProfileRevisionRow(
  row: Record<string, unknown>
): ApiKeyControlProfileRevisionRow {
  return {
    id: row.id as string,
    profile_id: row.profile_id as string,
    revision_number: row.revision_number as number,
    rules: asPostgresJsonArray(row.rules),
    default_action: row.default_action as ApiKeyControlProfileRevisionRow["default_action"],
    created_by: (row.created_by as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    activated_at: (row.activated_at as string | null | undefined) ?? null,
  };
}

function mapApiKeyWalletPolicyBindingRow(
  row: Record<string, unknown>
): ApiKeyWalletPolicyBindingRow {
  return {
    id: row.id as string,
    api_key_id: row.api_key_id as string,
    binding_scope: row.binding_scope as ApiKeyWalletPolicyBindingRow["binding_scope"],
    wallet_id: (row.wallet_id as string | null | undefined) ?? null,
    custody_wallet_id: (row.custody_wallet_id as string | null | undefined) ?? null,
    wallet_control_profile_id: (row.wallet_control_profile_id as string | null | undefined) ?? null,
    api_key_control_profile_id:
      (row.api_key_control_profile_id as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapApiKeyPolicySubjectRow(row: Record<string, unknown>): ApiKeyPolicySubjectRow {
  return {
    api_key_id: row.api_key_id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
  };
}

function mapApiKeyWalletPolicyTargetRow(row: Record<string, unknown>): ApiKeyWalletPolicyTargetRow {
  return {
    api_key_id: row.api_key_id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    wallet_id: row.wallet_id as string,
    custody_wallet_id: row.custody_wallet_id as string,
    wallet_project_id: (row.wallet_project_id as string | null | undefined) ?? null,
    endpoint_binding_count: Number(row.endpoint_binding_count ?? 0),
    endpoint_wallet_binding_id:
      (row.endpoint_wallet_binding_id as string | null | undefined) ?? null,
  };
}

function mapApiKeyWalletPolicyBindingResolutionRow(
  row: Record<string, unknown> | null
): ApiKeyWalletPolicyBindingResolutionRow {
  if (!row) {
    return {
      total_binding_count: 0,
      binding: null,
    };
  }

  return {
    total_binding_count: Number(row.total_binding_count ?? 0),
    binding: row.id ? mapApiKeyWalletPolicyBindingRow(row) : null,
  };
}

function mapWalletOperationRow(row: Record<string, unknown>): WalletOperationRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    custody_wallet_id: (row.custody_wallet_id as string | null | undefined) ?? null,
    wallet_id: row.wallet_id as string,
    api_key_id: (row.api_key_id as string | null | undefined) ?? null,
    source: row.source as string,
    operation_family: row.operation_family as WalletOperationRow["operation_family"],
    operation_type: row.operation_type as string,
    asset: (row.asset as string | null | undefined) ?? null,
    amount: (row.amount as string | null | undefined) ?? null,
    destination: (row.destination as string | null | undefined) ?? null,
    raw_payload: asPostgresJsonObject(row.raw_payload),
    idempotency_key: (row.idempotency_key as string | null | undefined) ?? null,
    status: row.status as WalletOperationRow["status"],
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapPolicyEvaluationRow(row: Record<string, unknown>): PolicyEvaluationRow {
  return {
    id: row.id as string,
    wallet_operation_id: row.wallet_operation_id as string,
    wallet_policy_revision_id: (row.wallet_policy_revision_id as string | null | undefined) ?? null,
    api_key_policy_revision_id:
      (row.api_key_policy_revision_id as string | null | undefined) ?? null,
    decision: row.decision as PolicyEvaluationRow["decision"],
    reason_code: row.reason_code as string,
    reason: (row.reason as string | null | undefined) ?? null,
    matched_rules: asPostgresJsonArray(row.matched_rules),
    evaluation_context: mapPolicyEvaluationContext(row.evaluation_context),
    requires_approval: row.requires_approval as boolean,
    approval_request_id: (row.approval_request_id as string | null | undefined) ?? null,
    created_at: row.created_at as string,
  };
}

function mapWalletPolicyEvaluationAuditRow(
  row: Record<string, unknown>
): WalletPolicyEvaluationAuditRow {
  return {
    wallet_operation_id: row.wallet_operation_id as string,
    policy_evaluation_id: row.policy_evaluation_id as string,
    operation_family: row.operation_family as WalletPolicyEvaluationAuditRow["operation_family"],
    operation_type: row.operation_type as string,
    asset: (row.asset as string | null | undefined) ?? null,
    amount: (row.amount as string | null | undefined) ?? null,
    destination: (row.destination as string | null | undefined) ?? null,
    operation_status: row.operation_status as WalletPolicyEvaluationAuditRow["operation_status"],
    wallet_policy_revision_id: (row.wallet_policy_revision_id as string | null | undefined) ?? null,
    active_wallet_policy_revision_id:
      (row.active_wallet_policy_revision_id as string | null | undefined) ?? null,
    api_key_policy_revision_id:
      (row.api_key_policy_revision_id as string | null | undefined) ?? null,
    active_api_key_policy_revision_id:
      (row.active_api_key_policy_revision_id as string | null | undefined) ?? null,
    decision: row.decision as WalletPolicyEvaluationAuditRow["decision"],
    reason_code: row.reason_code as string,
    reason: (row.reason as string | null | undefined) ?? null,
    matched_rules: asPostgresJsonArray(row.matched_rules),
    evaluation_context: mapPolicyEvaluationContext(row.evaluation_context),
    requires_approval: row.requires_approval as boolean,
    approval_request_id: (row.approval_request_id as string | null | undefined) ?? null,
    operation_created_at: row.operation_created_at as string,
    operation_updated_at: row.operation_updated_at as string,
    evaluated_at: row.evaluated_at as string,
  };
}

function mapApprovalRequestRow(row: Record<string, unknown>): ApprovalRequestRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    wallet_operation_id: row.wallet_operation_id as string,
    approval_group_id: (row.approval_group_id as string | null | undefined) ?? null,
    status: row.status as ApprovalRequestRow["status"],
    provider: (row.provider as string | null | undefined) ?? null,
    provider_reference: (row.provider_reference as string | null | undefined) ?? null,
    provider_payload: asPostgresJsonObject(row.provider_payload),
    requested_by: (row.requested_by as string | null | undefined) ?? null,
    resolved_by: (row.resolved_by as string | null | undefined) ?? null,
    expires_at: (row.expires_at as string | null | undefined) ?? null,
    resolved_at: (row.resolved_at as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapApprovalRequestDetailRow(row: Record<string, unknown>): ApprovalRequestDetailRow {
  return {
    approval_request_id: row.approval_request_id as string,
    organization_id: row.organization_id as string,
    project_id: (row.project_id as string | null | undefined) ?? null,
    wallet_operation_id: row.wallet_operation_id as string,
    approval_group_id: (row.approval_group_id as string | null | undefined) ?? null,
    approval_status: row.approval_status as ApprovalRequestDetailRow["approval_status"],
    provider: (row.provider as string | null | undefined) ?? null,
    provider_reference: (row.provider_reference as string | null | undefined) ?? null,
    requested_by: (row.requested_by as string | null | undefined) ?? null,
    resolved_by: (row.resolved_by as string | null | undefined) ?? null,
    expires_at: (row.expires_at as string | null | undefined) ?? null,
    resolved_at: (row.resolved_at as string | null | undefined) ?? null,
    approval_created_at: row.approval_created_at as string,
    approval_updated_at: row.approval_updated_at as string,
    custody_wallet_id: (row.custody_wallet_id as string | null | undefined) ?? null,
    wallet_id: row.wallet_id as string,
    wallet_public_key: (row.wallet_public_key as string | null | undefined) ?? null,
    wallet_label: (row.wallet_label as string | null | undefined) ?? null,
    api_key_id: (row.api_key_id as string | null | undefined) ?? null,
    source: row.source as string,
    operation_family: row.operation_family as ApprovalRequestDetailRow["operation_family"],
    operation_type: row.operation_type as string,
    asset: (row.asset as string | null | undefined) ?? null,
    amount: (row.amount as string | null | undefined) ?? null,
    destination: (row.destination as string | null | undefined) ?? null,
    operation_status: row.operation_status as ApprovalRequestDetailRow["operation_status"],
    operation_created_at: row.operation_created_at as string,
    operation_updated_at: row.operation_updated_at as string,
    policy_evaluation_id: (row.policy_evaluation_id as string | null | undefined) ?? null,
    decision: (row.decision as ApprovalRequestDetailRow["decision"] | null | undefined) ?? null,
    reason_code: (row.reason_code as string | null | undefined) ?? null,
    reason: (row.reason as string | null | undefined) ?? null,
    matched_rules: asPostgresJsonArray(row.matched_rules),
    requires_approval:
      row.requires_approval === null || row.requires_approval === undefined
        ? null
        : Boolean(row.requires_approval),
    evaluated_at: (row.evaluated_at as string | null | undefined) ?? null,
  };
}

function mapPolicyEvaluationContext(value: unknown): PolicyEvaluationRow["evaluation_context"] {
  const context = parseOptionalPostgresJson<Record<string, unknown>>(value);
  if (
    !isJsonObject(context) ||
    !isJsonObject(context.operation) ||
    !isJsonObject(context.walletPolicy) ||
    !Object.hasOwn(context, "apiKeyPolicy")
  ) {
    return null;
  }
  return context as unknown as PolicyEvaluationRow["evaluation_context"];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateApiKeyWalletPolicyBindingInput(input: UpsertApiKeyWalletPolicyBindingInput): void {
  if (input.bindingScope === "selected" && !input.walletId) {
    throw badRequest("walletId is required for selected API key wallet policy bindings");
  }

  if (input.bindingScope === "all" && (input.walletId || input.custodyWalletId)) {
    throw badRequest("walletId and custodyWalletId must be omitted for all-wallet policy bindings");
  }
}

function createWalletOperationRawPayload(
  input: CreateWalletOperationInput
): Record<string, unknown> {
  const rawPayload = { ...(input.rawPayload ?? {}) };

  if (input.actor !== undefined) {
    rawPayload.actor = input.actor;
  }
  if (input.context != null) {
    rawPayload.context = input.context;
  }
  if (input.providerExtensions != null) {
    rawPayload.providerExtensions = input.providerExtensions;
  }

  return rawPayload;
}

async function getWalletControlProfileById(
  db: AppDb,
  profileId: string
): Promise<WalletControlProfileRow | null> {
  const row = await db
    .prepare("SELECT * FROM wallet_control_profiles WHERE id = ?")
    .bind(profileId)
    .first<Record<string, unknown>>();

  return row ? mapWalletControlProfileRow(row) : null;
}

async function listApprovalRequestDetailsInternal(
  db: AppDb,
  input: ListApprovalRequestDetailsInput & { approvalRequestId?: string }
): Promise<ApprovalRequestDetailRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const conditions = ["ar.organization_id = ?"];
  const params: unknown[] = [input.organizationId];

  if (input.projectId) {
    conditions.push("ar.project_id = ?");
    params.push(input.projectId);
  }
  if (input.status) {
    conditions.push("ar.status = ?");
    params.push(input.status);
  }
  if (input.approvalRequestId) {
    conditions.push("ar.id = ?");
    params.push(input.approvalRequestId);
  }

  const rows = await db
    .prepare(
      `SELECT
         ar.id AS approval_request_id,
         ar.organization_id,
         ar.project_id,
         ar.wallet_operation_id,
         ar.approval_group_id,
         ar.status AS approval_status,
         ar.provider,
         ar.provider_reference,
         ar.requested_by,
         ar.resolved_by,
         ar.expires_at,
         ar.resolved_at,
         ar.created_at AS approval_created_at,
         ar.updated_at AS approval_updated_at,
         wo.custody_wallet_id,
         wo.wallet_id,
         cw.public_key AS wallet_public_key,
         cw.label AS wallet_label,
         wo.api_key_id,
         wo.source,
         wo.operation_family,
         wo.operation_type,
         wo.asset,
         wo.amount,
         wo.destination,
         wo.status AS operation_status,
         wo.created_at AS operation_created_at,
         wo.updated_at AS operation_updated_at,
         pe.id AS policy_evaluation_id,
         pe.decision,
         pe.reason_code,
         pe.reason,
         pe.matched_rules,
         pe.requires_approval,
         pe.created_at AS evaluated_at
       FROM approval_requests ar
       INNER JOIN wallet_operations wo ON wo.id = ar.wallet_operation_id
       LEFT JOIN custody_wallets cw ON cw.id = wo.custody_wallet_id
       LEFT JOIN LATERAL (
         SELECT *
         FROM policy_evaluations pe
         WHERE pe.approval_request_id = ar.id
         ORDER BY pe.created_at DESC
         LIMIT 1
       ) pe ON TRUE
       WHERE ${conditions.join(" AND ")}
       ORDER BY ar.created_at DESC, ar.id DESC
       LIMIT ?`
    )
    .bind(...params, limit)
    .all<Record<string, unknown>>();

  return rows.results.map(mapApprovalRequestDetailRow);
}

async function getWalletControlProfileRevisionById(
  db: AppDb,
  revisionId: string
): Promise<WalletControlProfileRevisionRow | null> {
  const row = await db
    .prepare("SELECT * FROM wallet_control_profile_revisions WHERE id = ?")
    .bind(revisionId)
    .first<Record<string, unknown>>();

  return row ? mapWalletControlProfileRevisionRow(row) : null;
}

async function getApiKeyControlProfileById(
  db: AppDb,
  profileId: string
): Promise<ApiKeyControlProfileRow | null> {
  const row = await db
    .prepare("SELECT * FROM api_key_control_profiles WHERE id = ?")
    .bind(profileId)
    .first<Record<string, unknown>>();

  return row ? mapApiKeyControlProfileRow(row) : null;
}

async function getApiKeyControlProfileRevisionById(
  db: AppDb,
  revisionId: string
): Promise<ApiKeyControlProfileRevisionRow | null> {
  const row = await db
    .prepare("SELECT * FROM api_key_control_profile_revisions WHERE id = ?")
    .bind(revisionId)
    .first<Record<string, unknown>>();

  return row ? mapApiKeyControlProfileRevisionRow(row) : null;
}

async function upsertApiKeyWalletPolicyBindingInternal(
  db: DatabaseExecutor,
  input: UpsertApiKeyWalletPolicyBindingInput
): Promise<ApiKeyWalletPolicyBindingRow | null> {
  const id = generateApiKeyWalletPolicyBindingId();
  const conflictTarget =
    input.bindingScope === "all"
      ? "(api_key_id) WHERE binding_scope = 'all'"
      : "(api_key_id, wallet_id) WHERE binding_scope = 'selected'";

  const row = await db
    .prepare(
      `INSERT INTO api_key_wallet_policy_bindings (
         id,
         api_key_id,
         binding_scope,
         wallet_id,
         custody_wallet_id,
         wallet_control_profile_id,
         api_key_control_profile_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET
         custody_wallet_id = EXCLUDED.custody_wallet_id,
         wallet_control_profile_id = EXCLUDED.wallet_control_profile_id,
         api_key_control_profile_id = EXCLUDED.api_key_control_profile_id,
         updated_at = sdp_iso_now()
       RETURNING *`
    )
    .bind(
      id,
      input.apiKeyId,
      input.bindingScope,
      input.walletId ?? null,
      input.custodyWalletId ?? null,
      input.walletControlProfileId ?? null,
      input.apiKeyControlProfileId ?? null
    )
    .first<Record<string, unknown>>();

  return row ? mapApiKeyWalletPolicyBindingRow(row) : null;
}

async function getWalletOperationByIdInternal(
  db: AppDb,
  walletOperationId: string
): Promise<WalletOperationRow | null> {
  const row = await db
    .prepare("SELECT * FROM wallet_operations WHERE id = ?")
    .bind(walletOperationId)
    .first<Record<string, unknown>>();

  return row ? mapWalletOperationRow(row) : null;
}

async function listPolicyEvaluationsForOperationInternal(
  db: AppDb,
  walletOperationId: string
): Promise<PolicyEvaluationRow[]> {
  const rows = await db
    .prepare(
      `SELECT *
       FROM policy_evaluations
       WHERE wallet_operation_id = ?
       ORDER BY created_at ASC`
    )
    .bind(walletOperationId)
    .all<Record<string, unknown>>();

  return rows.results.map(mapPolicyEvaluationRow);
}

async function getPolicyEvaluationByIdInternal(
  db: AppDb,
  policyEvaluationId: string
): Promise<PolicyEvaluationRow | null> {
  const row = await db
    .prepare("SELECT * FROM policy_evaluations WHERE id = ?")
    .bind(policyEvaluationId)
    .first<Record<string, unknown>>();

  return row ? mapPolicyEvaluationRow(row) : null;
}

const walletPolicyEvaluationAuditSelect = `SELECT
  wo.id AS wallet_operation_id,
  pe.id AS policy_evaluation_id,
  wo.operation_family,
  wo.operation_type,
  wo.asset,
  wo.amount,
  wo.destination,
  wo.status AS operation_status,
  pe.wallet_policy_revision_id,
  wcp.active_revision_id AS active_wallet_policy_revision_id,
  pe.api_key_policy_revision_id,
  akcp.active_revision_id AS active_api_key_policy_revision_id,
  pe.decision,
  pe.reason_code,
  pe.reason,
  pe.matched_rules,
  pe.evaluation_context,
  pe.requires_approval,
  pe.approval_request_id,
  wo.created_at AS operation_created_at,
  wo.updated_at AS operation_updated_at,
  pe.created_at AS evaluated_at
FROM policy_evaluations pe
INNER JOIN wallet_operations wo ON wo.id = pe.wallet_operation_id
LEFT JOIN wallet_control_profile_revisions wcpr ON wcpr.id = pe.wallet_policy_revision_id
LEFT JOIN wallet_control_profiles wcp ON wcp.id = wcpr.profile_id
LEFT JOIN api_key_control_profile_revisions akcpr ON akcpr.id = pe.api_key_policy_revision_id
LEFT JOIN api_key_control_profiles akcp ON akcp.id = akcpr.profile_id`;

function walletPolicyEvaluationAuditFilters(input: ListWalletPolicyEvaluationAuditsInput): {
  conditions: string[];
  params: unknown[];
} {
  const conditions = [
    "wo.organization_id = ?",
    "wo.project_id IS NOT DISTINCT FROM ?",
    "wo.custody_wallet_id = ?",
  ];
  const params: unknown[] = [input.organizationId, input.projectId, input.custodyWalletId];

  if (input.decision) {
    conditions.push("pe.decision = ?");
    params.push(input.decision);
  }
  if (input.status) {
    conditions.push("wo.status = ?");
    params.push(input.status);
  }
  if (input.operationFamily) {
    conditions.push("wo.operation_family = ?");
    params.push(input.operationFamily);
  }
  if (input.reasonCode) {
    conditions.push("pe.reason_code = ?");
    params.push(input.reasonCode);
  }

  return { conditions, params };
}

export function createPostgresPolicyRepository(db: AppDb): PolicyRepository {
  return {
    async listPolicyControlInventory(input: ListPolicyControlInventoryInput) {
      const page = Math.max(input.page ?? 1, 1);
      const pageSize = Math.min(Math.max(input.pageSize ?? 25, 1), 100);
      const offset = (page - 1) * pageSize;
      const summaryFilters = policyControlInventoryFilters(input, false);
      const summaryWhere =
        summaryFilters.conditions.length > 0 ? summaryFilters.conditions.join(" AND ") : "TRUE";
      const filteredTotalCondition = input.status ? "inventory.status = ?" : "TRUE";
      const summary = await db
        .prepare(
          `${POLICY_CONTROL_INVENTORY_CTE}
           SELECT
             COUNT(*) FILTER (WHERE ${filteredTotalCondition}) AS filtered_total,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE inventory.status = 'default_allow') AS default_allow,
             COUNT(*) FILTER (WHERE inventory.status = 'draft') AS draft,
             COUNT(*) FILTER (WHERE inventory.status = 'active') AS active,
             COUNT(*) FILTER (WHERE inventory.status = 'disabled') AS disabled,
             COALESCE(SUM(inventory.api_key_binding_count), 0) AS total_api_key_bindings
           FROM inventory
           WHERE ${summaryWhere}`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.walletIds ?? null,
          ...(input.status ? [input.status] : []),
          ...summaryFilters.params
        )
        .first<Record<string, unknown>>();

      const rowFilters = policyControlInventoryFilters(input, true);
      const rowWhere =
        rowFilters.conditions.length > 0 ? rowFilters.conditions.join(" AND ") : "TRUE";
      const rows = await db
        .prepare(
          `${POLICY_CONTROL_INVENTORY_CTE}
           SELECT *
           FROM inventory
           WHERE ${rowWhere}
           ORDER BY inventory.updated_at DESC, inventory.target_type ASC, inventory.target_id ASC
           LIMIT ? OFFSET ?`
        )
        .bind(
          input.organizationId,
          input.projectId,
          input.walletIds ?? null,
          ...rowFilters.params,
          pageSize,
          offset
        )
        .all<Record<string, unknown>>();

      return {
        rows: rows.results.map(mapPolicyControlInventoryRow),
        total: Number(summary?.filtered_total ?? 0),
        summary: {
          total: Number(summary?.total ?? 0),
          default_allow: Number(summary?.default_allow ?? 0),
          draft: Number(summary?.draft ?? 0),
          active: Number(summary?.active ?? 0),
          disabled: Number(summary?.disabled ?? 0),
          total_api_key_bindings: Number(summary?.total_api_key_bindings ?? 0),
        },
      };
    },

    async createWalletControlProfile(input: CreateWalletControlProfileInput) {
      const id = generateWalletControlProfileId();

      await db
        .prepare(
          `INSERT INTO wallet_control_profiles (
             id,
             organization_id,
             project_id,
             custody_wallet_id,
             name,
             status,
             created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.custodyWalletId,
          input.name,
          input.status ?? "draft",
          input.createdBy ?? null
        )
        .run();

      return getWalletControlProfileById(db, id);
    },

    async createWalletControlProfileRevision(input: CreateWalletControlProfileRevisionInput) {
      const id = generateWalletControlProfileRevisionId();
      const row = await db.transaction(async (tx) => {
        const profile = await tx
          .prepare("SELECT id FROM wallet_control_profiles WHERE id = ? FOR UPDATE")
          .bind(input.profileId)
          .first<{ id: string }>();

        if (!profile) {
          return null;
        }

        return tx
          .prepare(
            `INSERT INTO wallet_control_profile_revisions (
               id,
               profile_id,
               revision_number,
               rules,
               default_action,
               created_by
             )
             SELECT
               ?,
               ?,
               COALESCE(MAX(revision_number), 0) + 1,
               ?::jsonb,
               ?,
               ?
             FROM wallet_control_profile_revisions
             WHERE profile_id = ?
             RETURNING *`
          )
          .bind(
            id,
            input.profileId,
            JSON.stringify(input.rules ?? []),
            input.defaultAction ?? "allow",
            input.createdBy ?? null,
            input.profileId
          )
          .first<Record<string, unknown>>();
      });

      return row ? mapWalletControlProfileRevisionRow(row) : null;
    },

    async activateWalletControlProfileRevision(input: ActivateWalletControlProfileRevisionInput) {
      const activatedAt = input.activatedAt ?? new Date().toISOString();

      const profile = await db.transaction(async (tx) => {
        const revision = await tx
          .prepare(
            `UPDATE wallet_control_profile_revisions
             SET activated_at = COALESCE(activated_at, ?)
             WHERE id = ? AND profile_id = ?
             RETURNING *`
          )
          .bind(activatedAt, input.revisionId, input.profileId)
          .first<Record<string, unknown>>();

        if (!revision) {
          return null;
        }

        return tx
          .prepare(
            `UPDATE wallet_control_profiles
             SET status = 'active',
                 active_revision_id = ?,
                 activated_at = COALESCE(activated_at, ?),
                 updated_at = ?
             WHERE id = ?
             RETURNING *`
          )
          .bind(input.revisionId, activatedAt, activatedAt, input.profileId)
          .first<Record<string, unknown>>();
      });

      if (!profile) {
        return null;
      }

      const revision = await getWalletControlProfileRevisionById(db, input.revisionId);
      return {
        profile: mapWalletControlProfileRow(profile),
        revision,
      };
    },

    async getActiveWalletControlProfileByCustodyWalletId(custodyWalletId: string) {
      const profile = await db
        .prepare(
          `SELECT *
           FROM wallet_control_profiles
           WHERE custody_wallet_id = ?
             AND status = 'active'
           ORDER BY activated_at DESC NULLS LAST, created_at DESC
           LIMIT 1`
        )
        .bind(custodyWalletId)
        .first<Record<string, unknown>>();

      if (!profile) {
        return null;
      }

      const mappedProfile = mapWalletControlProfileRow(profile);
      const revision = mappedProfile.active_revision_id
        ? await getWalletControlProfileRevisionById(db, mappedProfile.active_revision_id)
        : null;

      return {
        profile: mappedProfile,
        revision,
      };
    },

    async getActiveWalletControlProfileByProfileId(profileId: string) {
      const profile = await db
        .prepare(
          `SELECT *
           FROM wallet_control_profiles
           WHERE id = ?
             AND status = 'active'
           LIMIT 1`
        )
        .bind(profileId)
        .first<Record<string, unknown>>();

      if (!profile) {
        return null;
      }

      const mappedProfile = mapWalletControlProfileRow(profile);
      const revision = mappedProfile.active_revision_id
        ? await getWalletControlProfileRevisionById(db, mappedProfile.active_revision_id)
        : null;

      return {
        profile: mappedProfile,
        revision,
      };
    },

    async getWalletControlProfileRevisionHistory(
      input: GetWalletControlProfileRevisionHistoryInput
    ) {
      const profile = await db
        .prepare(
          `SELECT *
           FROM wallet_control_profiles
           WHERE organization_id = ?
             AND project_id IS NOT DISTINCT FROM ?
             AND custody_wallet_id = ?
           ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                    updated_at DESC,
                    id DESC
           LIMIT 1`
        )
        .bind(input.organizationId, input.projectId, input.custodyWalletId)
        .first<Record<string, unknown>>();

      if (!profile) {
        return null;
      }

      const mappedProfile = mapWalletControlProfileRow(profile);
      const revisions = await db
        .prepare(
          `SELECT *
           FROM wallet_control_profile_revisions
           WHERE profile_id = ?
           ORDER BY revision_number DESC
           LIMIT ?`
        )
        .bind(mappedProfile.id, WALLET_CONTROL_PROFILE_REVISION_HISTORY_LIMIT)
        .all<Record<string, unknown>>();

      return {
        profile: mappedProfile,
        revisions: revisions.results.map(mapWalletControlProfileRevisionRow),
      };
    },

    async createApiKeyControlProfile(input: CreateApiKeyControlProfileInput) {
      const id = generateApiKeyControlProfileId();

      await db
        .prepare(
          `INSERT INTO api_key_control_profiles (
             id,
             organization_id,
             project_id,
             api_key_id,
             name,
             status,
             created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.apiKeyId,
          input.name,
          input.status ?? "draft",
          input.createdBy ?? null
        )
        .run();

      return getApiKeyControlProfileById(db, id);
    },

    async getApiKeyControlProfileById(profileId: string) {
      return getApiKeyControlProfileById(db, profileId);
    },

    async createApiKeyControlProfileRevision(input: CreateApiKeyControlProfileRevisionInput) {
      const id = generateApiKeyControlProfileRevisionId();
      const row = await db.transaction(async (tx) => {
        const profile = await tx
          .prepare("SELECT id FROM api_key_control_profiles WHERE id = ? FOR UPDATE")
          .bind(input.profileId)
          .first<{ id: string }>();

        if (!profile) {
          return null;
        }

        return tx
          .prepare(
            `INSERT INTO api_key_control_profile_revisions (
               id,
               profile_id,
               revision_number,
               rules,
               default_action,
               created_by
             )
             SELECT
               ?,
               ?,
               COALESCE(MAX(revision_number), 0) + 1,
               ?::jsonb,
               ?,
               ?
             FROM api_key_control_profile_revisions
             WHERE profile_id = ?
             RETURNING *`
          )
          .bind(
            id,
            input.profileId,
            JSON.stringify(input.rules ?? []),
            input.defaultAction ?? "allow",
            input.createdBy ?? null,
            input.profileId
          )
          .first<Record<string, unknown>>();
      });

      return row ? mapApiKeyControlProfileRevisionRow(row) : null;
    },

    async getApiKeyControlProfileRevisionById(revisionId: string) {
      return getApiKeyControlProfileRevisionById(db, revisionId);
    },

    async activateApiKeyControlProfileRevision(input: ActivateApiKeyControlProfileRevisionInput) {
      const activatedAt = input.activatedAt ?? new Date().toISOString();

      const profile = await db.transaction(async (tx) => {
        const revision = await tx
          .prepare(
            `UPDATE api_key_control_profile_revisions
             SET activated_at = COALESCE(activated_at, ?)
             WHERE id = ? AND profile_id = ?
             RETURNING *`
          )
          .bind(activatedAt, input.revisionId, input.profileId)
          .first<Record<string, unknown>>();

        if (!revision) {
          return null;
        }

        return tx
          .prepare(
            `UPDATE api_key_control_profiles
             SET status = 'active',
                 active_revision_id = ?,
                 activated_at = COALESCE(activated_at, ?),
                 updated_at = ?
             WHERE id = ?
             RETURNING *`
          )
          .bind(input.revisionId, activatedAt, activatedAt, input.profileId)
          .first<Record<string, unknown>>();
      });

      if (!profile) {
        return null;
      }

      const revision = await getApiKeyControlProfileRevisionById(db, input.revisionId);
      return {
        profile: mapApiKeyControlProfileRow(profile),
        revision,
      };
    },

    async getActiveApiKeyControlProfileByApiKeyId(apiKeyId: string) {
      const profile = await db
        .prepare(
          `SELECT *
           FROM api_key_control_profiles
           WHERE api_key_id = ?
             AND status = 'active'
           ORDER BY activated_at DESC NULLS LAST, created_at DESC
           LIMIT 1`
        )
        .bind(apiKeyId)
        .first<Record<string, unknown>>();

      if (!profile) {
        return null;
      }

      const mappedProfile = mapApiKeyControlProfileRow(profile);
      const revision = mappedProfile.active_revision_id
        ? await getApiKeyControlProfileRevisionById(db, mappedProfile.active_revision_id)
        : null;

      return {
        profile: mappedProfile,
        revision,
      };
    },

    async getActiveApiKeyControlProfileByProfileId(profileId: string) {
      const profile = await db
        .prepare(
          `SELECT *
           FROM api_key_control_profiles
           WHERE id = ?
             AND status = 'active'
           LIMIT 1`
        )
        .bind(profileId)
        .first<Record<string, unknown>>();

      if (!profile) {
        return null;
      }

      const mappedProfile = mapApiKeyControlProfileRow(profile);
      const revision = mappedProfile.active_revision_id
        ? await getApiKeyControlProfileRevisionById(db, mappedProfile.active_revision_id)
        : null;

      return {
        profile: mappedProfile,
        revision,
      };
    },

    async getApiKeyPolicySubject(apiKeyId: string) {
      const row = await db
        .prepare(
          `SELECT
             id AS api_key_id,
             organization_id,
             project_id
           FROM api_keys
           WHERE id = ?
             AND status = 'active'
           LIMIT 1`
        )
        .bind(apiKeyId)
        .first<Record<string, unknown>>();

      return row ? mapApiKeyPolicySubjectRow(row) : null;
    },

    async upsertApiKeyWalletPolicyBinding(input: UpsertApiKeyWalletPolicyBindingInput) {
      validateApiKeyWalletPolicyBindingInput(input);
      return upsertApiKeyWalletPolicyBindingInternal(db, input);
    },

    async replaceApiKeyWalletPolicyBindings(input: ReplaceApiKeyWalletPolicyBindingsInput) {
      if (input.bindings.some((binding) => binding.apiKeyId !== input.apiKeyId)) {
        throw badRequest("Policy bindings must target the requested API key");
      }
      for (const binding of input.bindings) {
        validateApiKeyWalletPolicyBindingInput(binding);
      }

      return db.transaction(async (tx) => {
        await tx
          .prepare("DELETE FROM api_key_wallet_policy_bindings WHERE api_key_id = ?")
          .bind(input.apiKeyId)
          .run();

        const rows: ApiKeyWalletPolicyBindingRow[] = [];
        for (const binding of input.bindings) {
          const row = await upsertApiKeyWalletPolicyBindingInternal(tx, binding);
          if (!row) {
            throw new Error("Failed to upsert API key wallet policy binding");
          }
          rows.push(row);
        }
        return rows;
      });
    },

    async listApiKeyWalletPolicyBindings(apiKeyId: string) {
      const rows = await db
        .prepare(
          `SELECT *
           FROM api_key_wallet_policy_bindings
           WHERE api_key_id = ?
           ORDER BY created_at ASC`
        )
        .bind(apiKeyId)
        .all<Record<string, unknown>>();

      return rows.results.map(mapApiKeyWalletPolicyBindingRow);
    },

    async listApiKeyWalletPolicyBindingsForApiKeys(apiKeyIds: string[]) {
      if (apiKeyIds.length === 0) {
        return [];
      }

      const rows = await db
        .prepare(
          `SELECT *
           FROM api_key_wallet_policy_bindings
           WHERE api_key_id = ANY(?::text[])
           ORDER BY api_key_id ASC, created_at ASC`
        )
        .bind(apiKeyIds)
        .all<Record<string, unknown>>();

      return rows.results.map(mapApiKeyWalletPolicyBindingRow);
    },

    async listActiveWalletControlProfileRevisionRefs(profileIds: string[]) {
      if (profileIds.length === 0) {
        return [];
      }

      const rows = await db
        .prepare(
          `SELECT id AS profile_id, active_revision_id
           FROM wallet_control_profiles
           WHERE id = ANY(?::text[])
             AND status = 'active'`
        )
        .bind(profileIds)
        .all<ActivePolicyProfileRevisionRefRow>();

      return rows.results;
    },

    async listActiveApiKeyControlProfileRevisionRefs(profileIds: string[]) {
      if (profileIds.length === 0) {
        return [];
      }

      const rows = await db
        .prepare(
          `SELECT id AS profile_id, active_revision_id
           FROM api_key_control_profiles
           WHERE id = ANY(?::text[])
             AND status = 'active'`
        )
        .bind(profileIds)
        .all<ActivePolicyProfileRevisionRefRow>();

      return rows.results;
    },

    async getApiKeyWalletPolicyBindingResolution(apiKeyId: string, walletId: string) {
      const row = await db
        .prepare(
          `WITH binding_count AS (
             SELECT COUNT(*) AS total_binding_count
             FROM api_key_wallet_policy_bindings
             WHERE api_key_id = ?
           ),
           applicable AS (
             SELECT *
             FROM api_key_wallet_policy_bindings
             WHERE api_key_id = ?
               AND (
                 binding_scope = 'all'
                 OR (binding_scope = 'selected' AND wallet_id = ?)
               )
             ORDER BY
               CASE WHEN binding_scope = 'selected' THEN 0 ELSE 1 END,
               updated_at DESC,
               created_at DESC
             LIMIT 1
           )
           SELECT
             binding_count.total_binding_count,
             applicable.*
           FROM binding_count
           LEFT JOIN applicable ON TRUE`
        )
        .bind(apiKeyId, apiKeyId, walletId)
        .first<Record<string, unknown>>();

      return mapApiKeyWalletPolicyBindingResolutionRow(row);
    },

    async getApiKeyWalletPolicyTarget(apiKeyId: string, walletId: string) {
      const row = await db
        .prepare(
          `WITH target_api_key AS (
             SELECT id, organization_id, project_id
             FROM api_keys
             WHERE id = ?
               AND status = 'active'
           ),
           endpoint_scope AS (
             SELECT api_key_id, COUNT(*) AS binding_count
             FROM api_key_wallet_permissions
             WHERE api_key_id = ?
             GROUP BY api_key_id
           )
           SELECT
             ak.id AS api_key_id,
             ak.organization_id,
             ak.project_id,
             w.wallet_id,
             w.id AS custody_wallet_id,
             c.project_id AS wallet_project_id,
             COALESCE(es.binding_count, 0) AS endpoint_binding_count,
             perm.id AS endpoint_wallet_binding_id
           FROM target_api_key ak
           JOIN custody_configs c
             ON c.organization_id = ak.organization_id
            AND c.status = 'active'
           JOIN custody_wallets w
             ON w.custody_config_id = c.id
            AND w.status = 'active'
            AND w.wallet_id = ?
           LEFT JOIN endpoint_scope es ON es.api_key_id = ak.id
           LEFT JOIN api_key_wallet_permissions perm
             ON perm.api_key_id = ak.id
            AND perm.wallet_id = w.wallet_id
           ORDER BY
             CASE
               WHEN c.project_id = ak.project_id THEN 0
               WHEN c.project_id IS NULL THEN 1
               ELSE 2
             END,
             w.created_at DESC
           LIMIT 1`
        )
        .bind(apiKeyId, apiKeyId, walletId)
        .first<Record<string, unknown>>();

      return row ? mapApiKeyWalletPolicyTargetRow(row) : null;
    },

    async createWalletOperation(input: CreateWalletOperationInput) {
      const id = generateWalletOperationId();

      await db
        .prepare(
          `INSERT INTO wallet_operations (
             id,
             organization_id,
             project_id,
             custody_wallet_id,
             wallet_id,
             api_key_id,
             source,
             operation_family,
             operation_type,
             asset,
             amount,
             destination,
             raw_payload,
             idempotency_key,
             status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.custodyWalletId ?? null,
          input.walletId,
          input.apiKeyId ?? null,
          input.source ?? "api",
          input.operationFamily,
          input.operationType,
          input.asset ?? null,
          input.amount ?? null,
          input.destination ?? null,
          JSON.stringify(createWalletOperationRawPayload(input)),
          input.idempotencyKey ?? null,
          input.status ?? "created"
        )
        .run();

      return getWalletOperationByIdInternal(db, id);
    },

    async getWalletOperationById(walletOperationId: string) {
      return getWalletOperationByIdInternal(db, walletOperationId);
    },

    async updateWalletOperationStatus(
      walletOperationId: string,
      status: WalletOperationRow["status"]
    ) {
      const row = await db
        .prepare(
          `UPDATE wallet_operations
           SET status = ?,
               updated_at = sdp_iso_now()
           WHERE id = ?
           RETURNING *`
        )
        .bind(status, walletOperationId)
        .first<Record<string, unknown>>();

      return row ? mapWalletOperationRow(row) : null;
    },

    async createPolicyEvaluation(input: CreatePolicyEvaluationInput) {
      const id = generatePolicyEvaluationId();

      await db
        .prepare(
          `INSERT INTO policy_evaluations (
             id,
             wallet_operation_id,
             wallet_policy_revision_id,
             api_key_policy_revision_id,
             decision,
             reason_code,
             reason,
             matched_rules,
             evaluation_context,
             requires_approval,
             approval_request_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)`
        )
        .bind(
          id,
          input.walletOperationId,
          input.walletPolicyRevisionId ?? null,
          input.apiKeyPolicyRevisionId ?? null,
          input.decision,
          input.reasonCode,
          input.reason ?? null,
          JSON.stringify(input.matchedRules ?? []),
          JSON.stringify(input.evaluationContext),
          input.requiresApproval ?? false,
          input.approvalRequestId ?? null
        )
        .run();

      return getPolicyEvaluationByIdInternal(db, id);
    },

    async listPolicyEvaluationsForOperation(walletOperationId: string) {
      return listPolicyEvaluationsForOperationInternal(db, walletOperationId);
    },

    async listWalletPolicyEvaluationAudits(input: ListWalletPolicyEvaluationAuditsInput) {
      const page = Math.max(input.page ?? 1, 1);
      const pageSize = Math.min(Math.max(input.pageSize ?? 25, 1), 100);
      const offset = (page - 1) * pageSize;
      const { conditions, params } = walletPolicyEvaluationAuditFilters(input);
      const where = conditions.join(" AND ");

      const count = await db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM policy_evaluations pe
           INNER JOIN wallet_operations wo ON wo.id = pe.wallet_operation_id
           WHERE ${where}`
        )
        .bind(...params)
        .first<{ total: number | string }>();

      const rows = await db
        .prepare(
          `${walletPolicyEvaluationAuditSelect}
           WHERE ${where}
           ORDER BY pe.created_at DESC, pe.id DESC
           LIMIT ? OFFSET ?`
        )
        .bind(...params, pageSize, offset)
        .all<Record<string, unknown>>();

      return {
        rows: rows.results.map(mapWalletPolicyEvaluationAuditRow),
        total: Number(count?.total ?? 0),
      };
    },

    async getWalletPolicyEvaluationAudit(input: GetWalletPolicyEvaluationAuditInput) {
      const { conditions, params } = walletPolicyEvaluationAuditFilters(input);
      conditions.push("pe.id = ?");
      params.push(input.policyEvaluationId);

      const row = await db
        .prepare(
          `${walletPolicyEvaluationAuditSelect}
           WHERE ${conditions.join(" AND ")}
           LIMIT 1`
        )
        .bind(...params)
        .first<Record<string, unknown>>();

      return row ? mapWalletPolicyEvaluationAuditRow(row) : null;
    },

    async createApprovalRequest(input: CreateApprovalRequestInput) {
      const id = generateApprovalRequestId();
      const row = await db
        .prepare(
          `INSERT INTO approval_requests (
             id,
             organization_id,
             project_id,
             wallet_operation_id,
             approval_group_id,
             provider,
             provider_reference,
             provider_payload,
             requested_by,
             expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
           ON CONFLICT (wallet_operation_id)
           -- Self-assignment forces RETURNING * to emit the existing row.
           -- ON CONFLICT DO NOTHING RETURNING * returns zero rows on conflict.
           DO UPDATE SET updated_at = approval_requests.updated_at
           RETURNING *`
        )
        .bind(
          id,
          input.organizationId,
          input.projectId,
          input.walletOperationId,
          input.approvalGroupId ?? null,
          input.provider ?? null,
          input.providerReference ?? null,
          JSON.stringify(input.providerPayload ?? {}),
          input.requestedBy ?? null,
          input.expiresAt ?? null
        )
        .first<Record<string, unknown>>();

      return row ? mapApprovalRequestRow(row) : null;
    },

    async updateApprovalRequestStatus(input: UpdateApprovalRequestStatusInput) {
      const resolvedAt = input.resolvedAt ?? new Date().toISOString();

      const row = await db.transaction(async (tx) => {
        const conditions = ["id = ?", "organization_id = ?"];
        const params: unknown[] = [input.approvalRequestId, input.organizationId];
        if (input.projectId) {
          conditions.push("project_id = ?");
          params.push(input.projectId);
        }

        const current = await tx
          .prepare(`SELECT * FROM approval_requests WHERE ${conditions.join(" AND ")} FOR UPDATE`)
          .bind(...params)
          .first<Record<string, unknown>>();

        if (!current) {
          return null;
        }
        if (current.status !== "pending") {
          return current;
        }

        const updated = await tx
          .prepare(
            `UPDATE approval_requests
             SET status = ?,
                 resolved_by = ?,
                 resolved_at = ?,
                 updated_at = ?
             WHERE id = ?
               AND organization_id = ?
             RETURNING *`
          )
          .bind(
            input.status,
            input.resolvedBy ?? null,
            resolvedAt,
            resolvedAt,
            input.approvalRequestId,
            input.organizationId
          )
          .first<Record<string, unknown>>();

        if (!updated) {
          return null;
        }

        if (input.operationStatus) {
          const currentOperationStatus =
            input.operationStatus === "failed"
              ? "status IN ('created', 'pending_approval')"
              : "status = 'pending_approval'";

          await tx
            .prepare(
              `UPDATE wallet_operations
               SET status = ?,
                   updated_at = ?
               WHERE id = ?
                 AND organization_id = ?
                 AND ${currentOperationStatus}`
            )
            .bind(
              input.operationStatus,
              resolvedAt,
              current.wallet_operation_id,
              input.organizationId
            )
            .run();
        }

        return updated;
      });

      return row ? mapApprovalRequestRow(row) : null;
    },

    async listApprovalRequestDetails(input: ListApprovalRequestDetailsInput) {
      return listApprovalRequestDetailsInternal(db, input);
    },

    async getApprovalRequestDetail(input: GetApprovalRequestDetailInput) {
      const rows = await listApprovalRequestDetailsInternal(db, {
        ...input,
        approvalRequestId: input.approvalRequestId,
        limit: 1,
      });

      return rows[0] ?? null;
    },
  };
}
