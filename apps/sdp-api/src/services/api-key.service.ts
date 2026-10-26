/**
 * API Key Service
 *
 * Shared data access for API key operations.
 */

// biome-ignore-all lint/security/noSecrets: service operation identifiers are not credentials
import { type Action, expandStoredGrants, normalizeGrants } from "@sdp/types/actions";
import type { ApiKeyEnvironment, ApiKeyStatus, ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { OrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { hashApiKey } from "@/lib/api-key-hash";
import { apiKeyRowRefusal } from "@/lib/api-key-rotation";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { assertTenantClaim, type TenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { createApiKeyMaterial } from "./api-key.utils";
import {
  type ApiKeyGrantChannel,
  assertApiKeyGrantsInReleaseChannel,
  assertGrantableApiKeyGrants,
} from "./api-key-scope.service";

export interface ApiKeyListItem {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  /** The key's explicit grants. */
  grants: Action[];
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  walletScope: ApiKeyWalletScope;
  /** The custody wallet ids a selected key may sign with; empty for `all`. */
  walletIds: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  /** When a rotated key stops working; null unless it was rotated and is in its grace period. */
  rotationDeadline: string | null;
  createdAt: string;
}

export interface ApiKeyDetails extends ApiKeyListItem {
  projectId: string;
  allowedIps: string[] | null;
  rotatedFrom: string | null;
}

export interface CreateApiKeyInput {
  organizationId: string;
  projectId: string;
  /** The signed-in person creating the key; API keys never manage keys. */
  createdByUserId: string;
  /** The signed-in person's organization role: a key holds only actions they hold. */
  actorRole: OrganizationRole;
  /** The deployment's release channel: a key holds only actions it runs. */
  grantChannel: ApiKeyGrantChannel;
  name: string;
  description?: string | null;
  grants: Action[];
  allowedIps?: string[] | null;
  expiresAt?: string | null;
  walletScope: ApiKeySigningWalletScope;
  pepper?: string;
}

/**
 * A key's wallet scope as it is stored (HOO-2099): `all`, or `selected` with
 * the exact custody wallet ids it may sign with (possibly none: signs nothing).
 * The ids are checked to be the project's custody wallets before they reach
 * here ({@link resolveSigningWalletsInProject}).
 */
const apiKeySigningWalletScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }),
  z.object({ scope: z.literal("selected"), custodyWalletIds: z.array(z.string()).readonly() }),
]);

export type ApiKeySigningWalletScope = z.infer<typeof apiKeySigningWalletScopeSchema>;

export interface UpdateApiKeyInput {
  keyId: string;
  organizationId: string;
  projectId: string;
  actorRole: OrganizationRole;
  /** The deployment's release channel: new grants must be actions it runs. */
  grantChannel: ApiKeyGrantChannel;
  name?: string;
  description?: string | null;
  grants?: Action[];
  allowedIps?: string[] | null;
  expiresAt?: string | null;
  /** Replaces the key's wallet scope and list. */
  walletScope?: ApiKeySigningWalletScope;
}

export interface CreateApiKeyResult {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  grants: Action[];
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
    grants: Action[];
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

interface ApiKeyListRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  grants: unknown;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  wallet_scope: ApiKeyWalletScope;
  wallet_ids: unknown;
  last_used_at: string | null;
  expires_at: string | null;
  rotation_deadline: string | null;
  created_at: string;
}

interface ApiKeyDetailsRow extends ApiKeyListRow {
  project_id: string;
  allowed_ips: string | null;
  rotated_from: string | null;
}

/** `api_keys.grants`, a `text[]` the driver returns as an array. */
const storedGrantsSchema = z.array(z.string());

/** A key's active `api_key_signing_wallets`, aggregated to a `text[]`. */
const walletIdsSchema = z.array(z.string());

/** The custody wallet ids a key lists, as a SELECT column (`wallet_ids`). */
const WALLET_IDS_COLUMN = `ARRAY(
                  SELECT s.custody_wallet_id
                    FROM api_key_signing_wallets s
                   WHERE s.api_key_id = ak.id AND s.status = 'active'
                   ORDER BY s.custody_wallet_id
                ) AS wallet_ids`;

/** API form of the column: aliases expanded, unknown strings dropped. */
export function parseGrantsColumn(value: unknown): Action[] {
  return expandStoredGrants(storedGrantsSchema.parse(value));
}

type RotationTargetRow = {
  id: string;
  name: string;
  description: string | null;
  grants: unknown;
  grants_assigned: boolean;
  environment: ApiKeyEnvironment;
  project_id: string;
  allowed_ips: string | null;
  wallet_scope: ApiKeyWalletScope;
  created_by: string;
  expires_at: string | null;
  status: ApiKeyStatus;
  rotation_deadline: string | null;
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

  async listForProject(projectId: string): Promise<ApiKeyListItem[]> {
    assertTenantClaim(
      this.scope,
      { organizationId: this.scope.organizationId, projectId },
      "ApiKeyService.listForProject"
    );
    const result = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.grants, p.environment, ak.status,
                ak.wallet_scope, ${WALLET_IDS_COLUMN},
                ak.last_used_at, ak.expires_at, ak.rotation_deadline, ak.created_at
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
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.grants, p.environment, ak.status,
                ak.project_id, ak.allowed_ips, ak.wallet_scope, ${WALLET_IDS_COLUMN},
                ak.last_used_at, ak.expires_at, ak.rotated_from,
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
      rotatedFrom: row.rotated_from,
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    assertTenantClaim(this.scope, input, "ApiKeyService.createApiKey");
    assertGrantableApiKeyGrants(input.actorRole, input.grants);
    assertApiKeyGrantsInReleaseChannel(input.grantChannel, input.grants);

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
    const { key, publicId, secret, prefix } = createApiKeyMaterial();
    const keyHash = await hashApiKey(secret, input.pepper);

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
            public_id, grants, allowed_ips, wallet_scope, expires_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
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
          publicId,
          normalizeGrants(input.grants),
          input.allowedIps ? JSON.stringify(input.allowedIps) : null,
          input.walletScope.scope,
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
    await this.writeSigningWallets(keyId, input.walletScope);

    return {
      id: keyId,
      name: input.name,
      key,
      keyPrefix: prefix,
      grants: normalizeGrants(input.grants),
      environment: project.environment,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      keyHash,
    };
  }

  async updateApiKey(input: UpdateApiKeyInput): Promise<void> {
    assertTenantClaim(this.scope, input, "ApiKeyService.updateApiKey");
    if (input.grants !== undefined) {
      assertGrantableApiKeyGrants(input.actorRole, input.grants);
      // Only a grant the key does not hold yet is being given now: one it kept
      // from before a channel change survives an edit that sends it back.
      const current = await this.db.queryOne<{ grants: unknown }>(
        `SELECT grants FROM api_keys
          WHERE id = $1 AND organization_id = $2 AND project_id = $3
          FOR UPDATE`,
        [input.keyId, input.organizationId, input.projectId]
      );
      if (!current) {
        throw notFound("API key");
      }
      const held = parseGrantsColumn(current.grants);
      assertApiKeyGrantsInReleaseChannel(
        input.grantChannel,
        input.grants.filter((grant) => !held.includes(grant))
      );
    }

    const updates: string[] = [];
    const values: (string | string[] | null)[] = [];

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
    if (input.grants !== undefined) {
      // A person set the grants: a key that predates them is usable again.
      updates.push("grants = ?", "grants_assigned = true");
      values.push(normalizeGrants(input.grants));
    }
    if (input.walletScope !== undefined) {
      updates.push("wallet_scope = ?");
      values.push(input.walletScope.scope);
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
    if (input.walletScope !== undefined) {
      await this.writeSigningWallets(input.keyId, input.walletScope);
    }
  }

  /**
   * Replace a key's signing list with the scope's: a selected key lists
   * exactly these custody wallets, an `all` key none. Runs on the caller's
   * transaction, right after the key row it belongs to.
   */
  private async writeSigningWallets(keyId: string, walletScope: ApiKeySigningWalletScope) {
    const listed =
      walletScope.scope === "selected" ? [...new Set(walletScope.custodyWalletIds)] : [];
    // Off the list: archived, never deleted.
    await this.db.execute(
      `UPDATE api_key_signing_wallets
          SET status = 'archived', archived_at = sdp_iso_now()
        WHERE api_key_id = ? AND status = 'active' AND NOT (custody_wallet_id = ANY(?::text[]))`,
      [keyId, listed]
    );
    if (listed.length > 0) {
      // On the list: a new row, or an archived one active again.
      await this.db.execute(
        `INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
         SELECT ?, unnest(?::text[])
         ON CONFLICT (api_key_id, custody_wallet_id) DO UPDATE
           SET status = 'active', archived_at = NULL
         WHERE api_key_signing_wallets.status = 'archived'`,
        [keyId, listed]
      );
    }
  }

  /**
   * Rotate a key: mint a replacement that copies the target and give the target
   * a grace deadline. Runs on the caller's transaction (the handler runs it
   * with its audit record), and locks the target row first, so a concurrent
   * rotation, revocation or update of the same key waits for this one and then
   * judges the row it left (APE-345, APE-723).
   *
   * Refuses a target that can no longer authenticate: not active (null, a
   * 404), or expired or past its rotation deadline (409), so a dead
   * predecessor whose replacement was revoked is never revived (APE-354). The
   * deadline only ever moves earlier: rotating again inside a grace period
   * keeps the earlier deadline.
   */
  async rotateApiKey(
    keyId: string,
    organizationId: string,
    projectId: string,
    gracePeriodHours: number,
    actorRole: OrganizationRole,
    pepper?: string
  ): Promise<RotateApiKeyResult | ApiKeyAlreadyRotatedResult | null> {
    assertTenantClaim(this.scope, { organizationId, projectId }, "ApiKeyService.rotateApiKey");

    // Lock order, shared by every writer of keys: the organization row first,
    // then key rows. Organization deletion updates the organization and then
    // its keys; createApiKey takes the organization share lock and then
    // inserts; revoke and update touch only the key row. Taking them in two
    // statements here keeps rotation in that order, so it can never hold a key
    // row while waiting on an organization a deletion holds.
    //
    // The organization share lock is createApiKey's: a replacement can't
    // commit under an organization a concurrent deletion has already revoked
    // (APE-358).
    const organization = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM organizations WHERE id = $1 AND status = 'active' FOR SHARE`,
      [organizationId]
    );
    if (!organization) {
      return null;
    }
    // The target's own row lock serializes every lifecycle change of this key
    // behind this rotation.
    const target = await this.db.queryOne<RotationTargetRow>(
      `SELECT ak.id, ak.name, ak.description, ak.grants, ak.grants_assigned,
              p.environment, ak.project_id, ak.allowed_ips,
              ak.wallet_scope, ak.created_by, ak.expires_at,
              ak.status, ak.rotation_deadline
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
        WHERE ak.id = $1 AND ak.organization_id = $2 AND ak.project_id = $3
          AND p.status = 'active'
        FOR UPDATE OF ak`,
      [keyId, organizationId, projectId]
    );
    if (target?.status !== "active") {
      return null;
    }
    const now = Date.now();
    if (apiKeyRowRefusal(target, now) !== null) {
      throw conflict(
        "This API key has expired or passed its rotation deadline and cannot be rotated; create a new key instead"
      );
    }

    // Rotation is a create, not an idempotent update: every attempt mints a
    // live credential whose secret exists only in that attempt's response. A
    // retry after a lost response, or a second concurrent attempt, waited on
    // the row lock above and finds the first one's replacement here.
    const replacement = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM api_keys
        WHERE rotated_from = $1 AND organization_id = $2 AND status = 'active'
        LIMIT 1`,
      [keyId, organizationId]
    );
    if (replacement) {
      return { alreadyRotatedTo: replacement.id };
    }

    const grants = parseGrantsColumn(target.grants);
    assertGrantableApiKeyGrants(actorRole, grants);

    const newKeyId = `key_${crypto.randomUUID()}`;
    const {
      key: newKey,
      publicId: newPublicId,
      secret: newSecret,
      prefix: newPrefix,
    } = createApiKeyMaterial();
    const newKeyHash = await hashApiKey(newSecret, pepper);

    const requestedDeadline = new Date(now + gracePeriodHours * 60 * 60 * 1000).toISOString();
    // Never extend a deadline: a second rotation inside a grace period keeps
    // the earlier one. The row lock makes this read-then-write monotonic.
    const rotationDeadline =
      target.rotation_deadline !== null &&
      Date.parse(target.rotation_deadline) < Date.parse(requestedDeadline)
        ? target.rotation_deadline
        : requestedDeadline;

    // Everything the replacement copies comes from the locked row and its
    // signing list: an update to this key waits for the lock, so it cannot
    // commit between this read and the copy.

    await this.db.execute(
      `INSERT INTO api_keys (
         id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
         public_id, grants, grants_assigned, allowed_ips, wallet_scope, rotated_from, status,
         expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        newKeyId,
        organizationId,
        target.project_id,
        target.created_by,
        target.name,
        target.description,
        newPrefix,
        newKeyHash,
        newPublicId,
        grants,
        // A replacement for a key that predates grants predates them too.
        target.grants_assigned,
        target.allowed_ips,
        target.wallet_scope,
        keyId,
        target.expires_at,
      ]
    );

    await this.db.execute(
      `UPDATE api_keys
          SET rotation_deadline = ?
        WHERE id = ? AND organization_id = ? AND project_id = ?`,
      [rotationDeadline, keyId, this.scope.organizationId, this.scope.projectId]
    );

    await this.db.execute(
      `INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
       SELECT ?, custody_wallet_id FROM api_key_signing_wallets
        WHERE api_key_id = ? AND status = 'active'`,
      [newKeyId, keyId]
    );

    return {
      apiKey: {
        id: newKeyId,
        name: target.name,
        key: newKey,
        keyPrefix: newPrefix,
        grants,
        environment: target.environment,
        expiresAt: target.expires_at,
        createdAt: new Date(now).toISOString(),
      },
      previousKey: {
        id: keyId,
        rotationDeadline,
      },
    };
  }

  /**
   * Revoke one key, and only that key: a replacement minted by rotating it
   * stays alive, so a user can rotate, deploy the replacement and then retire
   * the predecessor before its grace deadline. Runs on the caller's
   * transaction. The conditional update takes the key's row lock, so a
   * rotation of the same key either finished before it (its replacement
   * survives, as intended) or waits and then finds no active key to rotate.
   * Keys cannot manage keys (HOO-2099), so only a signed-in person reaches
   * either side of that race.
   *
   * @returns The revocation, `alreadyRevoked` for a key no longer active, or
   *   null when no such key exists in this project.
   */
  async revokeApiKey(
    keyId: string,
    organizationId: string,
    projectId: string
  ): Promise<
    | { revokedAt: string; alreadyRevoked: false }
    | { revokedAt: string; alreadyRevoked: true }
    | null
  > {
    assertTenantClaim(this.scope, { organizationId, projectId }, "ApiKeyService.revokeApiKey");
    const revokedAt = new Date().toISOString();
    const revoked = await this.db.queryOne<{ id: string }>(
      `UPDATE api_keys
          SET status = 'deactivated', revoked_at = ?
        WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'
        RETURNING id`,
      [revokedAt, keyId, organizationId, projectId]
    );

    if (!revoked) {
      const existing = await this.db.queryOne<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?",
        [keyId, organizationId, projectId]
      );
      if (!existing) {
        return null;
      }
      // Not active and never revoked (an expired key): there is no revocation to report.
      if (existing.revoked_at === null) {
        throw conflict("Only an active API key can be deactivated");
      }
      return { revokedAt: existing.revoked_at, alreadyRevoked: true };
    }

    return { revokedAt, alreadyRevoked: false };
  }

  private mapListRow(row: ApiKeyListRow): ApiKeyListItem {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      keyPrefix: row.key_prefix,
      grants: parseGrantsColumn(row.grants),
      environment: row.environment,
      status: row.status,
      walletScope: row.wallet_scope,
      walletIds: walletIdsSchema.parse(row.wallet_ids),
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      rotationDeadline: row.rotation_deadline,
      createdAt: row.created_at,
    };
  }
}
