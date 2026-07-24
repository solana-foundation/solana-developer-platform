/**
 * Session Service
 *
 * Manages user sessions for UI authentication.
 * Sessions are stored in Postgres.
 */

import type { CachedSession, Session } from "@sdp/types";
import { getPermissionsForOrgRole } from "@sdp/types";

// Session TTL: 7 days
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface SessionMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export class SessionService {
  constructor(private db: DatabaseClient) {}

  /**
   * Create a new session for a user
   */
  async createSession(
    userId: string,
    organizationId: string,
    metadata: SessionMetadata
  ): Promise<Session> {
    const id = `ses_${crypto.randomUUID()}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

    const session: Session = {
      id,
      userId,
      organizationId,
      authMethod: "session",
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      createdAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
    };

    await this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, ip_address, user_agent, expires_at, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        session.id,
        session.userId,
        session.organizationId,
        session.authMethod,
        session.ipAddress,
        session.userAgent,
        session.expiresAt,
        session.createdAt,
        session.lastActivityAt
      )
      .run();

    return session;
  }

  /**
   * Resolve a session against the member's current role and permissions.
   *
   * Membership state and permissions are authorization data and are always
   * read from Postgres, so removals and role changes take effect immediately.
   */
  async getSession(sessionId: string): Promise<CachedSession | null> {
    const row = await this.db
      .prepare(
        `SELECT s.id, s.user_id, s.organization_id, s.expires_at, s.revoked_at,
                om.role
         FROM sessions s
         JOIN organization_members om
           ON om.user_id = s.user_id
          AND om.organization_id = s.organization_id
          AND om.status = 'active'
         WHERE s.id = ? AND s.revoked_at IS NULL`
      )
      .bind(sessionId)
      .first<{
        id: string;
        user_id: string;
        organization_id: string;
        expires_at: string;
        revoked_at: string | null;
        role: string;
      }>();

    if (!row) {
      return null;
    }

    // Check expiration
    if (new Date(row.expires_at) < new Date()) {
      return null;
    }

    // Get permissions for the user's role
    const permissions = getPermissionsForOrgRole(row.role);

    return {
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      permissions,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Update last activity timestamp
   */
  async updateActivity(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
      .bind(now, sessionId)
      .run();
  }

  /**
   * Revoke a session
   */
  async revokeSession(sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?")
      .bind(now, sessionId)
      .run();
  }

  /**
   * Revoke all sessions for a user
   */
  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.revokeMatchingSessions("user_id = ?", [userId]);
  }

  /**
   * Revoke a user's sessions for one organization.
   */
  async revokeUserOrganizationSessions(userId: string, organizationId: string): Promise<void> {
    await this.revokeMatchingSessions("user_id = ? AND organization_id = ?", [
      userId,
      organizationId,
    ]);
  }

  /**
   * Revoke every session for an organization.
   */
  async revokeOrganizationSessions(organizationId: string): Promise<void> {
    await this.revokeMatchingSessions("organization_id = ?", [organizationId]);
  }

  private async revokeMatchingSessions(whereClause: string, bindings: string[]): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(`UPDATE sessions SET revoked_at = ? WHERE ${whereClause} AND revoked_at IS NULL`)
      .bind(now, ...bindings)
      .run();
  }

  /**
   * List active sessions for a user
   */
  async listUserSessions(userId: string): Promise<Session[]> {
    const result = await this.db
      .prepare(
        `SELECT id, user_id, organization_id, auth_method, ip_address, user_agent,
                expires_at, revoked_at, created_at, last_activity_at
         FROM sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
         ORDER BY created_at DESC`
      )
      .bind(userId)
      .all<{
        id: string;
        user_id: string;
        organization_id: string;
        auth_method: string;
        ip_address: string | null;
        user_agent: string | null;
        expires_at: string;
        revoked_at: string | null;
        created_at: string;
        last_activity_at: string | null;
      }>();

    return result.results.map((row) => ({
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      authMethod: row.auth_method as "session",
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    }));
  }
}
