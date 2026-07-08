/**
 * Audit Logging Service
 *
 * Records all significant actions for compliance and debugging.
 */

import type { Context } from "hono";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { redactCredentialSecrets } from "@/lib/redaction";
import type { Env } from "@/types/env";

export type AuditAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "revoke"
  | "invite"
  | "accept_invite"
  | "login"
  | "logout"
  | "api_call"
  | "deploy"
  | "mint"
  | "burn"
  | "freeze"
  | "unfreeze"
  | "seize"
  | "force_burn"
  | "update_authority"
  | "pause"
  | "unpause"
  // Transaction actions
  | "submit"
  | "submit_failed"
  | "sign"
  | "sign_requested"
  // BYO credential lifecycle actions
  | "validate_failed"
  | "check"
  | "activate"
  | "rotate"
  | "rollback"
  | "deactivate"
  | "blocked_deactivation";

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

  /**
   * Log an audit event
   */
  async log(c: Context<{ Bindings: Env }>, entry: AuditLogEntry): Promise<void> {
    const auth = c.get("apiKey");
    const requestId = c.get("requestId");

    const id = `aud_${crypto.randomUUID()}`;
    const ipAddress = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
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
          entry.organizationId || auth?.organizationId || null,
          entry.userId || null,
          entry.apiKeyId || auth?.id || null,
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

  /**
   * Query audit logs for an organization
   */
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
}
