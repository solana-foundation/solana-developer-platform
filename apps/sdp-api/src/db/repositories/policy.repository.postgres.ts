import type { AppDb } from "@/db";
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
  ApprovalRequestRow,
  CreateApiKeyControlProfileInput,
  CreateApiKeyControlProfileRevisionInput,
  CreateApprovalRequestInput,
  CreatePolicyEvaluationInput,
  CreateWalletControlProfileInput,
  CreateWalletControlProfileRevisionInput,
  CreateWalletOperationInput,
  ListWalletPolicyEvaluationAuditsInput,
  PolicyEvaluationRow,
  PolicyRepository,
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
    decision: row.decision as WalletPolicyEvaluationAuditRow["decision"],
    reason_code: row.reason_code as string,
    reason: (row.reason as string | null | undefined) ?? null,
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

export function createPostgresPolicyRepository(db: AppDb): PolicyRepository {
  return {
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
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
      const rows = await db
        .prepare(
          `SELECT
             wo.id AS wallet_operation_id,
             pe.id AS policy_evaluation_id,
             wo.operation_family,
             wo.operation_type,
             wo.asset,
             wo.amount,
             wo.destination,
             wo.status AS operation_status,
             pe.decision,
             pe.reason_code,
             pe.reason,
             pe.requires_approval,
             pe.approval_request_id,
             wo.created_at AS operation_created_at,
             wo.updated_at AS operation_updated_at,
             pe.created_at AS evaluated_at
           FROM policy_evaluations pe
           INNER JOIN wallet_operations wo ON wo.id = pe.wallet_operation_id
           WHERE wo.organization_id = ?
             AND wo.custody_wallet_id = ?
           ORDER BY pe.created_at DESC, wo.created_at DESC
           LIMIT ?`
        )
        .bind(input.organizationId, input.custodyWalletId, limit)
        .all<Record<string, unknown>>();

      return rows.results.map(mapWalletPolicyEvaluationAuditRow);
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
        const current = await tx
          .prepare(
            "SELECT * FROM approval_requests WHERE id = ? AND organization_id = ? FOR UPDATE"
          )
          .bind(input.approvalRequestId, input.organizationId)
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
  };
}
