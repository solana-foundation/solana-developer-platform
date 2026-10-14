import { normalizeAllowedOperations, upgradeStoredAllowedOperations } from "@sdp/types";
/**
 * API Key Service
 *
 * Shared data access for API key operations.
 */

// biome-ignore-all lint/security/noSecrets: service operation identifiers are not credentials
import { hashString } from "@sdp/payments/hash";
import type {
  AllowedOperation,
  ApiKeyEnvironment,
  ApiKeyRole,
  ApiKeyStatus,
  ApiKeyWalletScope,
  Permission,
} from "@sdp/types";
import { parseOptionalPostgresJson, parsePostgresJson } from "@/db/postgres-utils";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { assertTenantClaim, type TenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { createApiKeyMaterial } from "./api-key.utils";
import { assertGrantableApiKeyPermissions } from "./api-key-scope.service";

export interface ApiKeyListItem {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  /** Operation families/types the key may perform. Empty means unrestricted. */
  allowedOperations: AllowedOperation[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ApiKeyDetails extends ApiKeyListItem {
  projectId: string;
  allowedIps: string[] | null;
  permissions: Permission[] | null;
  signingWalletId: string | null;
  rotatedFrom: string | null;
  rotationDeadline: string | null;
}

export interface CreateApiKeyInput {
  organizationId: string;
  projectId: string;
  /** The signed-in person creating the key; API keys never manage keys. */
  createdByUserId: string;
  actorPermissions: Permission[];
  name: string;
  description?: string | null;
  role: ApiKeyRole;
  permissions?: Permission[] | null;
  allowedIps?: string[] | null;
  allowedOperations?: AllowedOperation[] | null;
  expiresAt?: string | null;
  signingWalletId?: string | null;
  pepper?: string;
}

export interface UpdateApiKeyInput {
  keyId: string;
  organizationId: string;
  projectId: string;
  actorPermissions: Permission[];
  currentRole: ApiKeyRole;
  name?: string;
  description?: string | null;
  allowedIps?: string[] | null;
  allowedOperations?: AllowedOperation[] | null;
  expiresAt?: string | null;
  permissions?: Permission[] | null;
  signingWallet?: { walletId: string | null };
}

export interface CreateApiKeyResult {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  expiresAt: string | null;
  createdAt: string;
  keyHash: string;
}

export interface RotateApiKeyResult {
  apiKey: {
    id: string;
    name: string;
    key: string;
    keyPrefix: string;
    role: ApiKeyRole;
    environment: ApiKeyEnvironment;
    expiresAt: string | null;
    createdAt: string;
  };
  previousKey: {
    id: string;
    rotationDeadline: string;
  };
}

/**
 * A live replacement for this key already exists, so the rotation that
 * created it already succeeded — this attempt is a duplicate (a retry after
 * a lost response, or a concurrent second request). Minting another key
 * would leave one live credential whose secret nobody holds.
 */
export interface ApiKeyAlreadyRotatedResult {
  alreadyRotatedTo: string;
}

export function isApiKeyAlreadyRotated(
  result: RotateApiKeyResult | ApiKeyAlreadyRotatedResult
): result is ApiKeyAlreadyRotatedResult {
  return "alreadyRotatedTo" in result;
}

export interface ApiKeyIdentity {
  id: string;
  name: string;
  keyPrefix: string;
}

export interface VerifyApiKeyOwnershipInput {
  apiKey: string;
  organizationId: string;
  projectId: string;
  pepper?: string;
}

interface ApiKeyListRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  wallet_scope: ApiKeyWalletScope;
  signing_wallet_id: string | null;
  allowed_operations: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ApiKeyDetailsRow extends ApiKeyListRow {
  project_id: string;
  allowed_ips: string | null;
  permissions: string | null;
  signing_wallet_id: string | null;
  rotated_from: string | null;
  rotation_deadline: string | null;
}

/** Column form of an Allowed Operations list: NULL when unrestricted. */
function serializeAllowedOperationsColumn(
  allowedOperations: AllowedOperation[] | null | undefined
): string | null {
  if (!allowedOperations || allowedOperations.length === 0) {
    return null;
  }
  return JSON.stringify(normalizeAllowedOperations(allowedOperations));
}

/** API form of the column: an empty list when unrestricted. */
export function parseAllowedOperationsColumn(value: string | null): AllowedOperation[] {
  return upgradeStoredAllowedOperations(parseOptionalPostgresJson<string[]>(value) ?? []);
}

function stringifyJsonb(value: unknown, fallback: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value ?? fallback);
}

type RotationTargetRow = {
  id: string;
  name: string;
  description: string | null;
  role: ApiKeyRole;
  permissions: string | null;
  environment: ApiKeyEnvironment;
  project_id: string;
  allowed_ips: string | null;
  allowed_operations: string | null;
  signing_wallet_id: string | null;
  created_by: string;
  expires_at: string | null;
};

export class ApiKeyService {
  constructor(
    private db: DatabaseClient,
    private scope: TenantScope
  ) {
    if (!scope.projectId) {
      throw new TenantScopeViolationError("ApiKeyService requires a project tenant scope");
    }
  }

  /**
   * Verifies full API-key material against the current tenant boundary.
   *
   * Display prefixes are intentionally not used here: they are short, public,
   * and not unique. The raw key is hashed in memory and is never stored.
   */
  /**
   * Resolves key material to the key it IS, not just to a yes or no. The match is
   * an exact hash lookup inside the org and project boundary, so the identity it
   * returns is the real row rather than anything inferred from the visible prefix.
   * Callers that only need usability can read the null.
   */
  async resolveUsableApiKey(input: VerifyApiKeyOwnershipInput): Promise<ApiKeyIdentity | null> {
    assertTenantClaim(this.scope, input, "ApiKeyService.resolveUsableApiKey");
    const keyHash = await hashString(input.apiKey, input.pepper);
    const row = await this.db
      .prepare(
        `SELECT id, name, key_prefix, status, expires_at
         FROM api_keys
         WHERE key_hash = ? AND organization_id = ? AND project_id = ?
         LIMIT 1`
      )
      .bind(keyHash, input.organizationId, input.projectId)
      .first<{
        id: string;
        name: string;
        key_prefix: string;
        status: ApiKeyStatus;
        expires_at: string | null;
      }>();

    if (row?.status !== "active") {
      return null;
    }

    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return null;
    }

    return { id: row.id, name: row.name, keyPrefix: row.key_prefix };
  }

  async listForProject(projectId: string): Promise<ApiKeyListItem[]> {
    assertTenantClaim(
      this.scope,
      { organizationId: this.scope.organizationId, projectId },
      "ApiKeyService.listForProject"
    );
    const result = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.role, p.environment, ak.status,
                CASE
                  WHEN ak.signing_wallet_id IS NOT NULL OR EXISTS (
                    SELECT 1
                    FROM api_key_wallet_permissions akw
                    WHERE akw.api_key_id = ak.id
                  )
                  THEN 'selected'
                  ELSE 'all'
                END AS wallet_scope,
                ak.signing_wallet_id, ak.allowed_operations, ak.last_used_at, ak.expires_at,
                ak.created_at
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE ak.organization_id = ?
           AND ak.project_id = ?
           AND ak.status NOT IN ('revoked', 'deactivated')
         ORDER BY ak.created_at DESC`
      )
      .bind(this.scope.organizationId, this.scope.projectId)
      .all<ApiKeyListRow>();

    return result.results.map((row) => this.mapListRow(row));
  }

  async getDetails(
    keyId: string,
    organizationId: string,
    projectId: string
  ): Promise<ApiKeyDetails | null> {
    assertTenantClaim(this.scope, { organizationId, projectId }, "ApiKeyService.getDetails");
    const row = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.role, p.environment, ak.status,
                ak.project_id, ak.allowed_ips, ak.permissions, ak.signing_wallet_id,
                CASE
                  WHEN ak.signing_wallet_id IS NOT NULL OR EXISTS (
                    SELECT 1
                    FROM api_key_wallet_permissions akw
                    WHERE akw.api_key_id = ak.id
                  )
                  THEN 'selected'
                  ELSE 'all'
                END AS wallet_scope,
                ak.allowed_operations, ak.last_used_at, ak.expires_at, ak.rotated_from,
                ak.rotation_deadline, ak.created_at
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE ak.id = ? AND ak.organization_id = ? AND ak.project_id = ?`
      )
      .bind(keyId, organizationId, projectId)
      .first<ApiKeyDetailsRow>();

    if (!row) {
      return null;
    }

    return {
      ...this.mapListRow(row),
      projectId: row.project_id,
      allowedIps: parseOptionalPostgresJson<string[]>(row.allowed_ips),
      permissions: row.permissions ? parsePostgresJson<Permission[]>(row.permissions) : null,
      signingWalletId: row.signing_wallet_id,
      rotatedFrom: row.rotated_from,
      rotationDeadline: row.rotation_deadline,
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    assertTenantClaim(this.scope, input, "ApiKeyService.createApiKey");
    assertGrantableApiKeyPermissions(input.actorPermissions, input.role, input.permissions);

    // The organization must still be active, and the share lock holds that
    // until this transaction commits: a concurrent deletion's
    // `UPDATE organizations` waits for it, and its key revocation then sees
    // (and revokes) the key inserted here. Without it, a create racing a
    // deletion commits an active key under a deleted organization (APE-358).
    // FOR KEY SHARE would not do: it does not conflict with a non-key update.
    const project = await this.db
      .prepare(
        `SELECT p.environment
           FROM projects p
           JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = ? AND p.organization_id = ? AND p.status = 'active'
            AND o.status = 'active'
          FOR SHARE OF o`
      )
      .bind(input.projectId, input.organizationId)
      .first<{ environment: ApiKeyEnvironment }>();

    if (!project) {
      throw notFound("Project");
    }

    const keyId = `key_${crypto.randomUUID()}`;
    const { key, prefix } = createApiKeyMaterial(project.environment);
    const keyHash = await hashString(key, input.pepper);

    const createdBy = input.createdByUserId;
    const actor = await this.db
      .prepare("SELECT id FROM users WHERE id = ?")
      .bind(createdBy)
      .first<{ id: string }>();

    if (!actor) {
      throw new AppError("INTERNAL_ERROR", "Authenticated actor could not be resolved");
    }

    try {
      await this.db
        .prepare(
          `INSERT INTO api_keys (
            id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
            role, permissions, allowed_ips, allowed_operations, signing_wallet_id, expires_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        )
        .bind(
          keyId,
          input.organizationId,
          input.projectId,
          createdBy,
          input.name,
          input.description ?? null,
          prefix,
          keyHash,
          input.role,
          input.permissions ? JSON.stringify(input.permissions) : null,
          input.allowedIps ? JSON.stringify(input.allowedIps) : null,
          serializeAllowedOperationsColumn(input.allowedOperations),
          input.signingWalletId ?? null,
          input.expiresAt ?? null
        )
        .run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw new AppError(
          "CONFLICT",
          "Failed to create API key due to a key collision. Please retry."
        );
      }

      if (error instanceof Error && error.message.includes("FOREIGN KEY")) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Creator account is not linked to this organization. Re-authenticate and try again."
        );
      }

      throw error;
    }

    return {
      id: keyId,
      name: input.name,
      key,
      keyPrefix: prefix,
      role: input.role,
      environment: project.environment,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      keyHash,
    };
  }

  async updateApiKey(input: UpdateApiKeyInput): Promise<void> {
    assertTenantClaim(this.scope, input, "ApiKeyService.updateApiKey");
    if (input.permissions !== undefined) {
      assertGrantableApiKeyPermissions(
        input.actorPermissions,
        input.currentRole,
        input.permissions
      );
    }

    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
    }
    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }
    if (input.allowedIps !== undefined) {
      updates.push("allowed_ips = ?");
      values.push(input.allowedIps ? JSON.stringify(input.allowedIps) : null);
    }
    if (input.expiresAt !== undefined) {
      updates.push("expires_at = ?");
      values.push(input.expiresAt);
    }
    if (input.allowedOperations !== undefined) {
      updates.push("allowed_operations = ?");
      values.push(serializeAllowedOperationsColumn(input.allowedOperations));
    }
    if (input.permissions !== undefined) {
      updates.push("permissions = ?");
      values.push(input.permissions ? JSON.stringify(input.permissions) : null);
    }
    if (input.signingWallet) {
      updates.push("signing_wallet_id = ?");
      values.push(input.signingWallet.walletId);
    }

    if (updates.length === 0) {
      throw badRequest("No fields to update");
    }

    values.push(input.keyId, input.organizationId, input.projectId);
    await this.db
      .prepare(
        `UPDATE api_keys SET ${updates.join(", ")} WHERE id = ? AND organization_id = ? AND project_id = ?`
      )
      .bind(...values)
      .run();
  }

  async rotateApiKey(
    keyId: string,
    organizationId: string,
    projectId: string,
    gracePeriodHours: number,
    actorPermissions: Permission[],
    pepper?: string
  ): Promise<RotateApiKeyResult | ApiKeyAlreadyRotatedResult | null> {
    assertTenantClaim(this.scope, { organizationId, projectId }, "ApiKeyService.rotateApiKey");
    const existing = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.role, ak.permissions,
                p.environment, ak.project_id, ak.allowed_ips, ak.allowed_operations,
                ak.signing_wallet_id, ak.created_by, ak.expires_at
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE ak.id = ? AND ak.organization_id = ? AND ak.project_id = ?
           AND ak.status = 'active' AND p.status = 'active'`
      )
      .bind(keyId, organizationId, projectId)
      .first<RotationTargetRow>();

    if (!existing) {
      return null;
    }

    assertGrantableApiKeyPermissions(
      actorPermissions,
      existing.role,
      existing.permissions === null ? null : parsePostgresJson<Permission[]>(existing.permissions)
    );

    const newKeyId = `key_${crypto.randomUUID()}`;
    const { key: newKey, prefix: newPrefix } = createApiKeyMaterial(existing.environment);
    const newKeyHash = await hashString(newKey, pepper);

    const rotationDeadline = new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000).toISOString();

    // Rotation is a create, not an idempotent update: every attempt mints a
    // live credential whose secret exists only in that attempt's response.
    // A retry after a lost response — or two concurrent attempts — would
    // otherwise leave a second active key nobody holds the secret for and
    // nothing distinguishes from a real one. The advisory lock serializes
    // attempts on this key so the replacement check below decides, and the
    // key material is hashed before the lock so no expensive work happens
    // inside it.
    const lockedTransactionWithPostCommit = this.db.lockedTransactionWithPostCommit?.bind(this.db);
    if (!lockedTransactionWithPostCommit) {
      throw new Error("Database client cannot serialize API key rotation");
    }

    let existingReplacementId: string | null = null;
    let committedTarget: RotationTargetRow | null = null;

    await lockedTransactionWithPostCommit(
      `api-key-rotation:${keyId}`,
      async (tx) => {
        // Serialized by the lock: a competing rotation of this key has
        // either not started or already committed its replacement.
        const replacement = await tx.queryOne<{ id: string }>(
          `SELECT id FROM api_keys
           WHERE rotated_from = $1 AND status = 'active'
           LIMIT 1`,
          [keyId]
        );
        if (replacement) {
          existingReplacementId = replacement.id;
          return;
        }

        // Everything the clone copies is judged and read on the rows this
        // transaction sees, not on what the caller read before the lock: a
        // permissions, IP, expiry or binding change committed in that
        // window would otherwise be cloned unchecked. The organization share
        // lock is createApiKey's: a replacement can't commit under an
        // organization a concurrent deletion has already revoked (APE-358).
        const target = await tx.queryOne<RotationTargetRow>(
          `SELECT ak.id, ak.name, ak.description, ak.role, ak.permissions,
                  p.environment, ak.project_id, ak.allowed_ips, ak.allowed_operations,
                  ak.signing_wallet_id, ak.created_by, ak.expires_at
           FROM api_keys ak
           JOIN projects p ON p.id = ak.project_id
           JOIN organizations o ON o.id = ak.organization_id
           WHERE ak.id = $1 AND ak.organization_id = $2 AND ak.project_id = $3
             AND ak.status = 'active' AND o.status = 'active'
           FOR SHARE OF o`,
          [keyId, organizationId, projectId]
        );
        if (!target) {
          return;
        }
        committedTarget = target;

        assertGrantableApiKeyPermissions(
          actorPermissions,
          target.role,
          target.permissions === null ? null : parsePostgresJson<Permission[]>(target.permissions)
        );

        const signingWalletId = target.signing_wallet_id;
        const bindingRows = await tx.queryMany<{ wallet_id: string; permissions: unknown }>(
          `SELECT wallet_id, permissions FROM api_key_wallet_permissions WHERE api_key_id = $1`,
          [keyId]
        );
        await tx
          .prepare(
            `INSERT INTO api_keys (
            id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
            role, permissions, allowed_ips, allowed_operations, signing_wallet_id, rotated_from, status, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
          )
          .bind(
            newKeyId,
            organizationId,
            target.project_id,
            target.created_by,
            target.name,
            target.description,
            newPrefix,
            newKeyHash,
            target.role,
            target.permissions,
            target.allowed_ips,
            target.allowed_operations,
            signingWalletId,
            keyId,
            target.expires_at
          )
          .run();

        await tx
          .prepare(
            `UPDATE api_keys
           SET rotation_deadline = ?
           WHERE id = ? AND organization_id = ? AND project_id = ?`
          )
          .bind(rotationDeadline, keyId, this.scope.organizationId, this.scope.projectId)
          .run();

        // The clone inserts the rows the guard judged, not a re-read of the
        // table — under READ COMMITTED an INSERT … SELECT would see rows
        // committed after the guard ran.
        for (const row of bindingRows) {
          await tx
            .prepare(
              `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
             VALUES (?, ?, ?, ?)`
            )
            .bind(
              `akw_${crypto.randomUUID()}`,
              newKeyId,
              row.wallet_id,
              // Preserve the column verbatim: NULL stays the historical
              // unrestricted marker, and a driver-parsed array re-serializes.
              row.permissions == null ? null : stringifyJsonb(row.permissions, [])
            )
            .run();
        }
      },
      // The caller owns the post-commit cache refresh (it holds the KV
      // handle) and must never fail the response over it, so nothing runs
      // here. The lock is what this helper is used for.
      async () => {}
    );

    if (existingReplacementId) {
      return { alreadyRotatedTo: existingReplacementId };
    }

    // The assignment happens inside the transaction callback, which TS's
    // control-flow analysis does not track.
    const rotated = committedTarget as RotationTargetRow | null;
    if (!rotated) {
      // The key was revoked or moved between the pre-flight read and the lock.
      return null;
    }

    return {
      apiKey: {
        id: newKeyId,
        name: rotated.name,
        key: newKey,
        keyPrefix: newPrefix,
        role: rotated.role,
        environment: rotated.environment,
        expiresAt: rotated.expires_at,
        createdAt: new Date().toISOString(),
      },
      previousKey: {
        id: keyId,
        rotationDeadline,
      },
    };
  }

  async revokeApiKey(
    keyId: string,
    organizationId: string,
    projectId: string
  ): Promise<{ revokedAt: string } | null> {
    assertTenantClaim(this.scope, { organizationId, projectId }, "ApiKeyService.revokeApiKey");
    const key = await this.db
      .prepare("SELECT id FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?")
      .bind(keyId, organizationId, projectId)
      .first<{ id: string }>();

    if (!key) {
      return null;
    }

    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE api_keys
         SET status = 'deactivated', revoked_at = ?
         WHERE id = ? AND organization_id = ? AND project_id = ?`
      )
      .bind(now, keyId, this.scope.organizationId, this.scope.projectId)
      .run();

    return { revokedAt: now };
  }

  private mapListRow(row: ApiKeyListRow): ApiKeyListItem {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      keyPrefix: row.key_prefix,
      role: row.role,
      environment: row.environment,
      status: row.status,
      walletScope: row.wallet_scope,
      signingWalletId: row.signing_wallet_id,
      allowedOperations: parseAllowedOperationsColumn(row.allowed_operations),
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
}
