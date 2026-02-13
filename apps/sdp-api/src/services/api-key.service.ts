/**
 * API Key Service
 *
 * Shared data access for API key operations.
 */

import { hashString } from "@/lib/hash";
import { AppError } from "@/lib/errors";
import type { ApiKeyEnvironment, ApiKeyRole, ApiKeyStatus, Permission } from "@sdp/types";
import { createApiKeyMaterial, parseJsonArray } from "./api-key.utils";

export interface ApiKeyListItem {
  id: string;
  name: string;
  description: string | null;
  keyPrefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ApiKeyDetails extends ApiKeyListItem {
  projectId: string | null;
  allowedIps: string[] | null;
  permissions: Permission[] | null;
  signingWalletId: string | null;
  rotatedFrom: string | null;
  rotationDeadline: string | null;
}

export interface CreateApiKeyInput {
  organizationId: string;
  projectId?: string | null;
  createdByKeyId?: string;
  createdByUserId?: string;
  name: string;
  description?: string | null;
  role: ApiKeyRole;
  permissions?: Permission[] | null;
  environment: ApiKeyEnvironment;
  allowedIps?: string[] | null;
  expiresAt?: string | null;
  signingWalletId?: string | null;
  pepper?: string;
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
  previousKeyHash: string;
}

interface ApiKeyListRow {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  status: ApiKeyStatus;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

interface ApiKeyDetailsRow extends ApiKeyListRow {
  project_id: string | null;
  allowed_ips: string | null;
  permissions: string | null;
  signing_wallet_id: string | null;
  rotated_from: string | null;
  rotation_deadline: string | null;
}

export class ApiKeyService {
  constructor(private db: D1Database) {}

  async listForOrganization(organizationId: string): Promise<ApiKeyListItem[]> {
    const result = await this.db
      .prepare(
        `SELECT id, name, description, key_prefix, role, environment, status,
                last_used_at, expires_at, created_at
         FROM api_keys
         WHERE organization_id = ? AND status != 'revoked'
         ORDER BY created_at DESC`
      )
      .bind(organizationId)
      .all<ApiKeyListRow>();

    return result.results.map((row) => this.mapListRow(row));
  }

  async listForProject(projectId: string): Promise<ApiKeyListItem[]> {
    const result = await this.db
      .prepare(
        `SELECT id, name, description, key_prefix, role, environment, status,
                last_used_at, expires_at, created_at
         FROM api_keys
         WHERE project_id = ? AND status != 'revoked'
         ORDER BY created_at DESC`
      )
      .bind(projectId)
      .all<ApiKeyListRow>();

    return result.results.map((row) => this.mapListRow(row));
  }

  async getDetails(keyId: string, organizationId: string): Promise<ApiKeyDetails | null> {
    const row = await this.db
      .prepare(
        `SELECT id, name, description, key_prefix, role, environment, status,
                project_id, allowed_ips, permissions, signing_wallet_id,
                last_used_at, expires_at, rotated_from, rotation_deadline, created_at
         FROM api_keys
         WHERE id = ? AND organization_id = ?`
      )
      .bind(keyId, organizationId)
      .first<ApiKeyDetailsRow>();

    if (!row) {
      return null;
    }

    return {
      ...this.mapListRow(row),
      projectId: row.project_id,
      allowedIps: parseJsonArray(row.allowed_ips),
      permissions: row.permissions ? (JSON.parse(row.permissions) as Permission[]) : null,
      signingWalletId: row.signing_wallet_id,
      rotatedFrom: row.rotated_from,
      rotationDeadline: row.rotation_deadline,
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const keyId = `key_${crypto.randomUUID()}`;
    const { key, prefix } = createApiKeyMaterial(input.environment);
    const keyHash = await hashString(key, input.pepper);

    let createdBy = input.createdByUserId?.trim() || "";

    if (!createdBy && input.createdByKeyId) {
      const creatorKey = await this.db
        .prepare("SELECT created_by FROM api_keys WHERE id = ?")
        .bind(input.createdByKeyId)
        .first<{ created_by: string }>();
      createdBy = creatorKey?.created_by || "";
    }

    if (!createdBy) {
      throw new AppError("INTERNAL_ERROR", "Unable to resolve API key creator");
    }

    await this.db
      .prepare(
        `INSERT INTO api_keys (
          id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
          role, permissions, environment, allowed_ips, signing_wallet_id, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        keyId,
        input.organizationId,
        input.projectId ?? null,
        createdBy,
        input.name,
        input.description ?? null,
        prefix,
        keyHash,
        input.role,
        input.permissions ? JSON.stringify(input.permissions) : null,
        input.environment,
        input.allowedIps ? JSON.stringify(input.allowedIps) : null,
        input.signingWalletId ?? null,
        input.expiresAt ?? null
      )
      .run();

    return {
      id: keyId,
      name: input.name,
      key,
      keyPrefix: prefix,
      role: input.role,
      environment: input.environment,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      keyHash,
    };
  }

  async rotateApiKey(
    keyId: string,
    organizationId: string,
    gracePeriodHours: number,
    pepper?: string
  ): Promise<RotateApiKeyResult | null> {
    const existing = await this.db
      .prepare(
        `SELECT id, name, description, key_hash, role, permissions, environment, project_id, allowed_ips, signing_wallet_id, created_by
         FROM api_keys
         WHERE id = ? AND organization_id = ? AND status = 'active'`
      )
      .bind(keyId, organizationId)
      .first<{
        id: string;
        name: string;
        description: string | null;
        key_hash: string;
        role: ApiKeyRole;
        permissions: string | null;
        environment: ApiKeyEnvironment;
        project_id: string | null;
        allowed_ips: string | null;
        signing_wallet_id: string | null;
        created_by: string;
      }>();

    if (!existing) {
      return null;
    }

    const newKeyId = `key_${crypto.randomUUID()}`;
    const { key: newKey, prefix: newPrefix } = createApiKeyMaterial(existing.environment);
    const newKeyHash = await hashString(newKey, pepper);

    const rotationDeadline = new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000).toISOString();

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO api_keys (
            id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
            role, permissions, environment, allowed_ips, signing_wallet_id, rotated_from, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        )
        .bind(
          newKeyId,
          organizationId,
          existing.project_id,
          existing.created_by,
          existing.name,
          existing.description,
          newPrefix,
          newKeyHash,
          existing.role,
          existing.permissions,
          existing.environment,
          existing.allowed_ips,
          existing.signing_wallet_id,
          keyId
        ),
      this.db
        .prepare("UPDATE api_keys SET rotation_deadline = ? WHERE id = ?")
        .bind(rotationDeadline, keyId),
    ]);

    return {
      apiKey: {
        id: newKeyId,
        name: existing.name,
        key: newKey,
        keyPrefix: newPrefix,
        role: existing.role,
        environment: existing.environment,
        expiresAt: null,
        createdAt: new Date().toISOString(),
      },
      previousKey: {
        id: keyId,
        rotationDeadline,
      },
      previousKeyHash: existing.key_hash,
    };
  }

  async revokeApiKey(keyId: string, organizationId: string): Promise<{ keyHash: string } | null> {
    const key = await this.db
      .prepare("SELECT id, key_hash FROM api_keys WHERE id = ? AND organization_id = ?")
      .bind(keyId, organizationId)
      .first<{ id: string; key_hash: string }>();

    if (!key) {
      return null;
    }

    await this.db
      .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?")
      .bind(keyId)
      .run();

    return { keyHash: key.key_hash };
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
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }
}
