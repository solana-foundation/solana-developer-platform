/**
 * Audit Logging Service
 *
 * Records all significant actions for compliance and debugging.
 */

import { redactCredentialSecrets } from "@sdp/custody";
import type { Context } from "hono";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { getClientIp } from "@/lib/client-ip";
import type { Env } from "@/types/env";

// Runtime list is the source of truth for the AuditAction type so callers can
// validate arbitrary input (e.g. an ?action= query filter) at runtime.
export const AUDIT_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "revoke",
  "invite",
  "accept_invite",
  "login",
  "logout",
  "api_call",
  "deploy",
  "mint",
  "burn",
  "freeze",
  "unfreeze",
  "seize",
  "force_burn",
  "update_authority",
  "pause",
  "unpause",
  // Transaction actions
  "submit",
  "submit_failed",
  "sign",
  "sign_requested",
  // BYO credential lifecycle actions
  "validate_failed",
  "check",
  "activate",
  "rotate",
  "rollback",
  "deactivate",
  "blocked_deactivation",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export type ResourceType =
  | "organization"
  | "user"
  | "api_key"
  | "invitation"
  | "allowlist"
  | "member"
  | "project"
  | "project_member"
  | "session"
  | "token"
  | "token_transaction"
  | "token_allowlist"
  | "frozen_account"
  | "custody_config"
  | "custody_wallet"
  // Transaction resources
  | "transaction"
  | "signing_request"
  | "counterparty"
  | "counterparty_account"
  | "asset_profile"
  | "provider_credential"
  | "custody_connection";

export interface AuditLogEntry {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  status?: "success" | "failure";
}

export class AuditService {
  constructor(private db: DatabaseClient) {}

  async log(c: Context<{ Bindings: Env }>, entry: AuditLogEntry): Promise<void> {
    // Resolve the actor from whichever auth context is present. Dashboard
    // requests carry a Clerk/session context (a user), API requests carry an
    // apiKey context; earlier this only read `apiKey`, so dashboard-driven
    // events were written with a null organization_id/user_id and became
    // invisible to org-scoped queries.
    const auth = c.get("apiKey");
    const clerk = c.get("clerk");
    const session = c.get("session");
    const requestId = c.get("requestId");

    const organizationId =
      entry.organizationId ||
      auth?.organizationId ||
      clerk?.organizationId ||
      session?.organizationId ||
      null;
    const userId = entry.userId || clerk?.userId || session?.userId || null;
    const apiKeyId = entry.apiKeyId || auth?.id || null;

    const id = `aud_${crypto.randomUUID()}`;
    const ipAddress = getClientIp(c);
    const userAgent = c.req.header("user-agent") || null;
    const metadata = entry.metadata ? redactCredentialSecrets(entry.metadata) : null;

    try {
      await this.db
        .prepare(
          `INSERT INTO audit_logs (
            id, organization_id, user_id, api_key_id, action, resource_type,
            resource_id, metadata, ip_address, user_agent, request_id, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          organizationId,
          userId,
          apiKeyId,
          entry.action,
          entry.resourceType,
          entry.resourceId || null,
          metadata ? JSON.stringify(metadata) : null,
          ipAddress,
          userAgent,
          requestId,
          entry.status || "success"
        )
        .run();
    } catch (err) {
      // Log but don't fail the request
      console.error("Failed to write audit log:", redactCredentialSecrets(err));
    }
  }

  async getForOrganization(
    organizationId: string,
    options: {
      limit?: number;
      offset?: number;
      action?: AuditAction;
      resourceType?: ResourceType;
      startDate?: string;
      endDate?: string;
    } = {}
  ) {
    const { limit = 50, offset = 0, action, resourceType, startDate, endDate } = options;

    let query = `
      SELECT id, organization_id, user_id, api_key_id, action, resource_type,
             resource_id, metadata, ip_address, request_id, status, created_at
      FROM audit_logs
      WHERE organization_id = ?
    `;
    const params: (string | number)[] = [organizationId];

    if (action) {
      query += " AND action = ?";
      params.push(action);
    }

    if (resourceType) {
      query += " AND resource_type = ?";
      params.push(resourceType);
    }

    if (startDate) {
      query += " AND created_at >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND created_at <= ?";
      params.push(endDate);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const results = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return results.results.map((row) => ({
      id: row.id as string,
      organizationId: row.organization_id as string,
      userId: row.user_id as string | null,
      apiKeyId: row.api_key_id as string | null,
      action: row.action as AuditAction,
      resourceType: row.resource_type as ResourceType,
      resourceId: row.resource_id as string | null,
      metadata: parseOptionalPostgresJson<Record<string, unknown>>(row.metadata),
      ipAddress: row.ip_address as string | null,
      requestId: row.request_id as string | null,
      status: row.status as "success" | "failure",
      createdAt: row.created_at as string,
    }));
  }

  /**
   * Get count of audit logs for pagination
   */
  async countForOrganization(
    organizationId: string,
    options: {
      action?: AuditAction;
      resourceType?: ResourceType;
    } = {}
  ): Promise<number> {
    const { action, resourceType } = options;

    let query = "SELECT COUNT(*) as count FROM audit_logs WHERE organization_id = ?";
    const params: string[] = [organizationId];

    if (action) {
      query += " AND action = ?";
      params.push(action);
    }

    if (resourceType) {
      query += " AND resource_type = ?";
      params.push(resourceType);
    }

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .first<{ count: number }>();

    return result?.count || 0;
  }

  /**
   * Query audit events for a single asset (issued token). Aggregates every event
   * tied to the token: rows logged directly against the token id, plus child
   * events (transactions, allowlist entries, frozen accounts) which store the
   * owning token id in `metadata.tokenId`. Resolves the actor to a display label.
   */
  async getForAsset(
    organizationId: string,
    tokenId: string,
    options: AssetAuditFilters & { limit?: number; offset?: number } = {}
  ): Promise<AssetAuditRecord[]> {
    const { limit = 50, offset = 0, ...filters } = options;

    // metadata is stored as JSON text; cast to jsonb to read `tokenId`. All
    // org-scoped rows are SDP-written via JSON.stringify, so the cast is safe.
    let query = `
      SELECT a.id, a.user_id, a.api_key_id, a.action, a.resource_type, a.resource_id,
             a.metadata, a.status, a.created_at,
             ak.name AS api_key_name, u.name AS user_name, u.email AS user_email
      FROM audit_logs a
      LEFT JOIN api_keys ak ON ak.id = a.api_key_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.organization_id = ?
        AND (
          a.resource_id = ?
          OR (a.metadata IS NOT NULL AND (a.metadata::jsonb) ->> 'tokenId' = ?)
        )
    `;
    const params: (string | number)[] = [organizationId, tokenId, tokenId];

    const filter = buildAssetFilterClause(filters);
    query += filter.clause;
    params.push(...filter.params);

    query += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const results = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return results.results.map((row) => {
      const userId = (row.user_id as string | null) ?? null;
      const apiKeyId = (row.api_key_id as string | null) ?? null;
      const actorType: "user" | "api_key" | "system" = userId
        ? "user"
        : apiKeyId
          ? "api_key"
          : "system";
      const actorLabel = userId
        ? (row.user_name as string | null) || (row.user_email as string | null) || "Team member"
        : apiKeyId
          ? (row.api_key_name as string | null) || "API key"
          : "SDP";

      return {
        id: row.id as string,
        action: row.action as AuditAction,
        resourceType: row.resource_type as ResourceType,
        resourceId: (row.resource_id as string | null) ?? null,
        userId,
        apiKeyId,
        actorType,
        actorLabel,
        metadata: parseOptionalPostgresJson<Record<string, unknown>>(row.metadata),
        status: row.status as "success" | "failure",
        createdAt: row.created_at as string,
      };
    });
  }

  /**
   * Count of audit events for a single asset (for pagination totals).
   */
  async countForAsset(
    organizationId: string,
    tokenId: string,
    options: AssetAuditFilters = {}
  ): Promise<number> {
    let query = `
      SELECT COUNT(*) as count
      FROM audit_logs a
      WHERE a.organization_id = ?
        AND (
          a.resource_id = ?
          OR (a.metadata IS NOT NULL AND (a.metadata::jsonb) ->> 'tokenId' = ?)
        )
    `;
    const params: (string | number)[] = [organizationId, tokenId, tokenId];

    const filter = buildAssetFilterClause(options);
    query += filter.clause;
    params.push(...filter.params);

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .first<{ count: number }>();

    return result?.count || 0;
  }
}

/**
 * Filters for the per-asset activity feed. `actorType` has no stored column —
 * it's derived from which actor id is set, so it maps to id-presence predicates.
 */
export interface AssetAuditFilters {
  action?: AuditAction;
  status?: "success" | "failure";
  actorType?: "user" | "api_key" | "system";
}

/** Build the shared `AND ...` filter clause used by getForAsset/countForAsset. */
function buildAssetFilterClause(filters: AssetAuditFilters): {
  clause: string;
  params: (string | number)[];
} {
  let clause = "";
  const params: (string | number)[] = [];

  if (filters.action) {
    clause += " AND a.action = ?";
    params.push(filters.action);
  }
  if (filters.status) {
    clause += " AND a.status = ?";
    params.push(filters.status);
  }
  // actorType mirrors the actorType derivation in getForAsset: user wins if a
  // user id is set, else api_key, else system (no human/key actor).
  switch (filters.actorType) {
    case "user":
      clause += " AND a.user_id IS NOT NULL";
      break;
    case "api_key":
      clause += " AND a.user_id IS NULL AND a.api_key_id IS NOT NULL";
      break;
    case "system":
      clause += " AND a.user_id IS NULL AND a.api_key_id IS NULL";
      break;
  }

  return { clause, params };
}

/** An audit event scoped to one asset, with the actor resolved to a label. */
export interface AssetAuditRecord {
  id: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string | null;
  userId: string | null;
  apiKeyId: string | null;
  actorType: "user" | "api_key" | "system";
  actorLabel: string;
  metadata: Record<string, unknown> | null;
  status: "success" | "failure";
  createdAt: string;
}
