/**
 * Session Authentication Middleware
 *
 * Validates session cookies for UI authentication.
 * Sessions are cached in KV for fast lookups.
 */

import type { CachedSession } from "@sdp/types";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

const SESSION_COOKIE_NAME = "sdp_session";

/**
 * Session authentication middleware
 * Validates session cookie and sets auth context
 */
export function sessionAuthMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);

    if (!sessionId) {
      throw new AppError("UNAUTHORIZED", "Session required");
    }

    // Try KV cache first
    let cachedSession = await getSessionFromKV(c.env.SDP_SESSIONS, sessionId);

    if (!cachedSession) {
      // Fallback to Postgres
      cachedSession = await getSessionFromDatabase(getDb(c.env), c.env.SDP_SESSIONS, sessionId);
    }

    if (!cachedSession) {
      throw new AppError("UNAUTHORIZED", "Invalid or expired session");
    }

    // Check expiration
    if (new Date(cachedSession.expiresAt) < new Date()) {
      // Clean up expired session
      await c.env.SDP_SESSIONS?.delete(`session:${sessionId}`);
      throw new AppError("UNAUTHORIZED", "Session expired");
    }

    // Set session context
    c.set("session", cachedSession);

    // Update last activity (fire and forget)
    updateLastActivity(getDb(c.env), sessionId);

    await next();
  };
}

/**
 * Optional session auth - doesn't fail if no session provided
 */
export function optionalSessionAuth() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);

    if (sessionId) {
      try {
        let cachedSession = await getSessionFromKV(c.env.SDP_SESSIONS, sessionId);

        if (!cachedSession) {
          cachedSession = await getSessionFromDatabase(getDb(c.env), c.env.SDP_SESSIONS, sessionId);
        }

        if (cachedSession && new Date(cachedSession.expiresAt) >= new Date()) {
          c.set("session", cachedSession);
          updateLastActivity(getDb(c.env), sessionId);
        }
      } catch {
        // Ignore errors for optional auth
      }
    }

    await next();
  };
}

/**
 * Get session from KV cache
 */
async function getSessionFromKV(
  kv: KVNamespace | undefined,
  sessionId: string
): Promise<CachedSession | null> {
  if (!kv) {
    return null;
  }
  return kv.get(`session:${sessionId}`, "json");
}

/**
 * Get session from Postgres and cache to KV
 */
async function getSessionFromDatabase(
  db: DatabaseClient,
  kv: KVNamespace | undefined,
  sessionId: string
): Promise<CachedSession | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.organization_id, s.expires_at, s.revoked_at,
              om.role
       FROM sessions s
       JOIN organization_members om ON om.user_id = s.user_id AND om.organization_id = s.organization_id
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

  // Get permissions for role
  const { getPermissionsForOrgRole } = await import("@sdp/types");
  const permissions = getPermissionsForOrgRole(row.role);

  const cachedSession: CachedSession = {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    permissions,
    expiresAt: row.expires_at,
  };

  // Cache to KV
  if (kv) {
    await kv.put(`session:${sessionId}`, JSON.stringify(cachedSession), {
      expirationTtl: 3600, // 1 hour
    });
  }

  return cachedSession;
}

/**
 * Update last activity timestamp (fire and forget)
 */
function updateLastActivity(db: DatabaseClient, sessionId: string) {
  db.prepare("UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?")
    .bind(sessionId)
    .run()
    .catch((err) => console.error("Failed to update session activity:", err));
}
