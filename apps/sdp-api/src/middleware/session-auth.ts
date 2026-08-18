/**
 * Session Authentication Middleware
 *
 * Validates session cookies for UI authentication.
 */

import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { enforceOrganizationIpAllowlist } from "@/lib/organization-ip-allowlist";
import { getLogger } from "@/runtime/logger";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import { DASHBOARD_ACTOR_MAX_REQUESTS, enforceRateLimit } from "./rate-limit";

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

    const sessionService = new SessionService(getDb(c.env));
    const cachedSession = await sessionService.getSession(sessionId);

    if (!cachedSession) {
      throw new AppError("UNAUTHORIZED", "Invalid or expired session");
    }

    // Cookie sessions are the other dashboard auth mode with no per-key
    // limit; meter them per user per org like Clerk traffic.
    await enforceRateLimit(
      c,
      `user:${cachedSession.userId}:org:${cachedSession.organizationId}`,
      DASHBOARD_ACTOR_MAX_REQUESTS
    );

    // Behind the limiter: an uncached Postgres read per request.
    await enforceOrganizationIpAllowlist(c, cachedSession.organizationId);

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
        const sessionService = new SessionService(getDb(c.env));
        const cachedSession = await sessionService.getSession(sessionId);

        if (cachedSession) {
          await enforceRateLimit(
            c,
            `user:${cachedSession.userId}:org:${cachedSession.organizationId}`,
            DASHBOARD_ACTOR_MAX_REQUESTS
          );
          // Before the context is set: a disallowed origin continues as anonymous.
          await enforceOrganizationIpAllowlist(c, cachedSession.organizationId);
          c.set("session", cachedSession);
          updateLastActivity(getDb(c.env), sessionId);
        }
      } catch (error) {
        // Ignore errors for optional auth, but never rate limiting — a
        // limited user must not proceed as anonymous.
        if (error instanceof AppError && error.code === "RATE_LIMITED") {
          throw error;
        }
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
    .catch((err) => getLogger().error({ error: err }, "Failed to update session activity"));
}
