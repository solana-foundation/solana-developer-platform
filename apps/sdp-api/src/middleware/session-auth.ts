/**
 * Session Authentication Middleware
 *
 * Validates session cookies for UI authentication.
 * Sessions are cached in KV for fast lookups.
 */

import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { SessionService } from "@/services/session.service";
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

    const sessionsKV = c.var.kv.sessions;
    const sessionService = new SessionService(getDb(c.env), sessionsKV);
    const cachedSession = await sessionService.getSession(sessionId);

    if (!cachedSession) {
      throw new AppError("UNAUTHORIZED", "Invalid or expired session");
    }

    // Check expiration
    if (new Date(cachedSession.expiresAt) < new Date()) {
      // Clean up expired session
      await sessionsKV.delete(`session:${sessionId}`);
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
        const sessionsKV = c.var.kv.sessions;
        const sessionService = new SessionService(getDb(c.env), sessionsKV);
        const cachedSession = await sessionService.getSession(sessionId);

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
 * Update last activity timestamp (fire and forget)
 */
function updateLastActivity(db: DatabaseClient, sessionId: string) {
  db.prepare("UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?")
    .bind(sessionId)
    .run()
    .catch((err) => console.error("Failed to update session activity:", err));
}
