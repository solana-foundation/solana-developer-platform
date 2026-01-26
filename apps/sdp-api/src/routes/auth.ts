/**
 * Auth Routes
 *
 * Handles magic link authentication and session management.
 */

import { AppError, notFound } from "@/lib/errors";
import { noContent, success } from "@/lib/response";
import { sessionAuthMiddleware } from "@/middleware/session-auth";
import { AuditService } from "@/services/audit.service";
import { MagicLinkService } from "@/services/magic-link.service";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import type {
  CurrentUserResponse,
  ListSessionsResponse,
  OrganizationRole,
  SendMagicLinkResponse,
  VerifyMagicLinkResponse,
} from "@sdp/types";
import { getPermissionsForOrgRole } from "@sdp/types";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";

const auth = new Hono<{ Bindings: Env }>();

// Validation schemas
const sendMagicLinkSchema = z.object({
  email: z.string().email(),
  organizationId: z.string().optional(),
});

// Cookie settings
const SESSION_COOKIE_NAME = "sdp_session";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Send a magic link
 * POST /v1/auth/magic-link
 */
auth.post("/magic-link", async (c) => {
  const body = await c.req.json();
  const parsed = sendMagicLinkSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { email, organizationId } = parsed.data;

  // Check if user exists
  const user = await c.env.DB.prepare("SELECT id, email, status FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<{ id: string; email: string; status: string }>();

  if (!user) {
    // Don't reveal if user exists
    const response: SendMagicLinkResponse = {
      success: true,
      message: "If an account exists for this email, a magic link has been sent.",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    return success(c, response);
  }

  if (user.status !== "active") {
    throw new AppError("UNAUTHORIZED", "Account is not active");
  }

  // If organizationId provided, verify membership
  if (organizationId) {
    const membership = await c.env.DB.prepare(
      "SELECT id FROM organization_members WHERE user_id = ? AND organization_id = ? AND status = 'active'"
    )
      .bind(user.id, organizationId)
      .first();

    if (!membership) {
      throw new AppError("UNAUTHORIZED", "Not a member of this organization");
    }
  }

  // Create magic link
  const magicLinkService = new MagicLinkService(c.env.DB);
  const { token, expiresAt } = await magicLinkService.createMagicLink(email, organizationId);

  // In development, log the token (in production, send email)
  if (c.env.ENVIRONMENT === "development") {
    console.log(`[DEV] Magic link token for ${email}: ${token}`);
  } else {
    // TODO: Send email with magic link
    // The URL would be: ${FRONTEND_URL}/auth/verify?token=${token}
    console.log(`Magic link created for ${email}, token not logged in production`);
  }

  const response: SendMagicLinkResponse = {
    success: true,
    message: "If an account exists for this email, a magic link has been sent.",
    expiresAt,
  };

  return success(c, response);
});

/**
 * Verify magic link and create session
 * GET /v1/auth/magic-link/verify?token=xxx
 */
auth.get("/magic-link/verify", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    throw new AppError("BAD_REQUEST", "Token is required");
  }

  // Verify token
  const magicLinkService = new MagicLinkService(c.env.DB);
  const result = await magicLinkService.verifyMagicLink(token);

  if (!result) {
    throw new AppError("INVALID_TOKEN", "Invalid or expired magic link");
  }

  // Get user
  const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE email = ?")
    .bind(result.email)
    .first<{ id: string; email: string; name: string | null }>();

  if (!user) {
    throw new AppError("NOT_FOUND", "User not found");
  }

  // Get organization membership (use provided org or first org)
  let membership: {
    organization_id: string;
    role: string;
    name: string;
    slug: string;
  } | null = null;

  if (result.organizationId) {
    membership = await c.env.DB.prepare(
      `SELECT om.organization_id, om.role, o.name, o.slug
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = ? AND om.organization_id = ? AND om.status = 'active'`
    )
      .bind(user.id, result.organizationId)
      .first<{
        organization_id: string;
        role: string;
        name: string;
        slug: string;
      }>();
  } else {
    // Get first organization
    membership = await c.env.DB.prepare(
      `SELECT om.organization_id, om.role, o.name, o.slug
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = ? AND om.status = 'active'
       ORDER BY om.created_at ASC
       LIMIT 1`
    )
      .bind(user.id)
      .first<{
        organization_id: string;
        role: string;
        name: string;
        slug: string;
      }>();
  }

  // Get permissions for the role
  const permissions = membership
    ? getPermissionsForOrgRole(membership.role as OrganizationRole)
    : [];

  // Create session
  const sessionService = new SessionService(c.env.DB, c.env.SDP_SESSIONS);
  const session = await sessionService.createSession(
    user.id,
    membership?.organization_id ?? "",
    permissions,
    {
      ipAddress: c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? undefined,
      userAgent: c.req.header("User-Agent") ?? undefined,
    }
  );

  // Update login tracking
  await c.env.DB.prepare(
    "UPDATE users SET last_login_at = datetime('now'), login_count = COALESCE(login_count, 0) + 1 WHERE id = ?"
  )
    .bind(user.id)
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "login",
    resourceType: "user",
    resourceId: user.id,
    metadata: { method: "magic_link" },
  });

  // Set session cookie
  setCookie(c, SESSION_COOKIE_NAME, session.id, {
    path: "/",
    httpOnly: true,
    secure: c.env.ENVIRONMENT !== "development",
    sameSite: "Lax",
    maxAge: COOKIE_MAX_AGE,
  });

  const response: VerifyMagicLinkResponse = {
    session: {
      id: session.id,
      expiresAt: session.expiresAt,
    },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    organization: membership
      ? {
          id: membership.organization_id,
          name: membership.name,
          slug: membership.slug,
        }
      : null,
  };

  return success(c, response);
});

/**
 * Logout (invalidate session)
 * POST /v1/auth/logout
 */
auth.post("/logout", sessionAuthMiddleware(), async (c) => {
  const session = c.get("session");

  if (session) {
    const sessionService = new SessionService(c.env.DB, c.env.SDP_SESSIONS);
    await sessionService.revokeSession(session.id);
  }

  // Clear cookie
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
  });

  return success(c, { success: true });
});

/**
 * Get current user info
 * GET /v1/auth/me
 */
auth.get("/me", sessionAuthMiddleware(), async (c) => {
  const session = c.get("session");

  if (!session) {
    throw new AppError("UNAUTHORIZED");
  }

  // Get user details
  const user = await c.env.DB.prepare(
    "SELECT id, email, name, last_login_at, login_count FROM users WHERE id = ?"
  )
    .bind(session.userId)
    .first<{
      id: string;
      email: string;
      name: string | null;
      last_login_at: string | null;
      login_count: number | null;
    }>();

  if (!user) {
    throw notFound("User");
  }

  // Get organization with role
  const orgMembership = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.tier, om.role
     FROM organizations o
     JOIN organization_members om ON om.organization_id = o.id
     WHERE o.id = ? AND om.user_id = ?`
  )
    .bind(session.organizationId, session.userId)
    .first<{
      id: string;
      name: string;
      slug: string;
      tier: string;
      role: string;
    }>();

  if (!orgMembership) {
    throw notFound("Organization membership");
  }

  const response: CurrentUserResponse = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      lastLoginAt: user.last_login_at,
      loginCount: user.login_count ?? 0,
    },
    organization: {
      id: orgMembership.id,
      name: orgMembership.name,
      slug: orgMembership.slug,
      tier: orgMembership.tier,
      role: orgMembership.role,
    },
    permissions: session.permissions,
  };

  return success(c, response);
});

/**
 * List active sessions
 * GET /v1/auth/sessions
 */
auth.get("/sessions", sessionAuthMiddleware(), async (c) => {
  const session = c.get("session");

  if (!session) {
    throw new AppError("UNAUTHORIZED");
  }

  const sessionService = new SessionService(c.env.DB, c.env.SDP_SESSIONS);
  const sessions = await sessionService.listUserSessions(session.userId);

  const response: ListSessionsResponse = {
    sessions: sessions.map((s) => ({
      id: s.id,
      authMethod: s.authMethod,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      current: s.id === session.id,
    })),
  };

  return success(c, response);
});

/**
 * Revoke a specific session
 * DELETE /v1/auth/sessions/:sessionId
 */
auth.delete("/sessions/:sessionId", sessionAuthMiddleware(), async (c) => {
  const { sessionId } = c.req.param();
  const currentSession = c.get("session");

  if (!currentSession) {
    throw new AppError("UNAUTHORIZED");
  }

  const sessionService = new SessionService(c.env.DB, c.env.SDP_SESSIONS);

  // Verify the session belongs to this user
  const sessions = await sessionService.listUserSessions(currentSession.userId);
  const targetSession = sessions.find((s) => s.id === sessionId);

  if (!targetSession) {
    throw notFound("Session");
  }

  await sessionService.revokeSession(sessionId);

  // If revoking current session, clear cookie
  if (sessionId === currentSession.id) {
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
    });
  }

  return noContent(c);
});

export default auth;
