/**
 * API Key Service
 *
 * Shared data access for API key operations.
 */

import type { ApiKeyEnvironment, ApiKeyRole, ApiKeyStatus, Permission } from "@sdp/types";
import { AppError } from "@/lib/errors";
import { hashString } from "@/lib/hash";
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
  createdByKeyId?: string;
  createdByUserId?: string;
  name: string;
  description?: string | null;
  role: ApiKeyRole;
  permissions?: Permission[] | null;
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
  project_id: string;
  allowed_ips: string | null;
  permissions: string | null;
  signing_wallet_id: string | null;
  rotated_from: string | null;
  rotation_deadline: string | null;
}

export class ApiKeyService {
  constructor(private db: DatabaseClient) {}

  async listForProject(projectId: string): Promise<ApiKeyListItem[]> {
    const result = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.role, p.environment, ak.status,
                ak.last_used_at, ak.expires_at, ak.created_at
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE ak.project_id = ? AND ak.status NOT IN ('revoked', 'deactivated')
         ORDER BY ak.created_at DESC`
      )
      .bind(projectId)
      .all<ApiKeyListRow>();

    return result.results.map((row) => this.mapListRow(row));
  }

  async getDetails(
    keyId: string,
    organizationId: string,
    projectId: string
  ): Promise<ApiKeyDetails | null> {
    const row = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_prefix, ak.role, p.environment, ak.status,
                ak.project_id, ak.allowed_ips, ak.permissions, ak.signing_wallet_id,
                ak.last_used_at, ak.expires_at, ak.rotated_from, ak.rotation_deadline, ak.created_at
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
      allowedIps: parseJsonArray(row.allowed_ips),
      permissions: row.permissions ? (JSON.parse(row.permissions) as Permission[]) : null,
      signingWalletId: row.signing_wallet_id,
      rotatedFrom: row.rotated_from,
      rotationDeadline: row.rotation_deadline,
    };
  }

  async createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const project = await this.db
      .prepare(`SELECT environment FROM projects WHERE id = ? AND organization_id = ?`)
      .bind(input.projectId, input.organizationId)
      .first<{ environment: ApiKeyEnvironment }>();

    if (!project) {
      throw new AppError("NOT_FOUND", "Project not found");
    }

    const keyId = `key_${crypto.randomUUID()}`;
    const { key, prefix } = createApiKeyMaterial(project.environment);
    const keyHash = await hashString(key, input.pepper);

    let createdBy = input.createdByUserId?.trim() || "";

    if (!createdBy && input.createdByKeyId) {
      const creatorKey = await this.db
        .prepare("SELECT created_by FROM api_keys WHERE id = ?")
        .bind(input.createdByKeyId)
        .first<{ created_by: string }>();
      createdBy = creatorKey?.created_by || "";
    }

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
            role, permissions, allowed_ips, signing_wallet_id, expires_at, status
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
          input.role,
          input.permissions ? JSON.stringify(input.permissions) : null,
          input.allowedIps ? JSON.stringify(input.allowedIps) : null,
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

  async rotateApiKey(
    keyId: string,
    organizationId: string,
    projectId: string,
    gracePeriodHours: number,
    pepper?: string
  ): Promise<RotateApiKeyResult | null> {
    const existing = await this.db
      .prepare(
        `SELECT ak.id, ak.name, ak.description, ak.key_hash, ak.role, ak.permissions,
                p.environment, ak.project_id, ak.allowed_ips, ak.signing_wallet_id, ak.created_by
         FROM api_keys ak
         JOIN projects p ON p.id = ak.project_id
         WHERE ak.id = ? AND ak.organization_id = ? AND ak.project_id = ? AND ak.status = 'active'`
      )
      .bind(keyId, organizationId, projectId)
      .first<{
        id: string;
        name: string;
        description: string | null;
        key_hash: string;
        role: ApiKeyRole;
        permissions: string | null;
        environment: ApiKeyEnvironment;
        project_id: string;
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
            role, permissions, allowed_ips, signing_wallet_id, rotated_from, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
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
          existing.allowed_ips,
          existing.signing_wallet_id,
          keyId
        ),
      this.db
        .prepare("UPDATE api_keys SET rotation_deadline = ? WHERE id = ?")
        .bind(rotationDeadline, keyId),
      this.db
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
           SELECT
             'akw_' || md5(random()::text || clock_timestamp()::text),
             ?,
             wallet_id,
             permissions
           FROM api_key_wallet_permissions
           WHERE api_key_id = ?`
        )
        .bind(newKeyId, keyId),
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

  async revokeApiKey(
    keyId: string,
    organizationId: string,
    projectId: string
  ): Promise<{
    keyHash: string;
    revokedAt: string;
  } | null> {
    const key = await this.db
      .prepare(
        "SELECT id, key_hash FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?"
      )
      .bind(keyId, organizationId, projectId)
      .first<{ id: string; key_hash: string }>();

    if (!key) {
      return null;
    }

    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE api_keys SET status = 'deactivated', revoked_at = ? WHERE id = ?")
      .bind(now, keyId)
      .run();

    return { keyHash: key.key_hash, revokedAt: now };
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
