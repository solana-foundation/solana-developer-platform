import type { CurrentUserResponse, ListSessionsResponse } from "@sdp/types";
import type { Context } from "hono";
import { deleteCookie } from "hono/cookie";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { noContent, success } from "@/lib/response";
import { sessionAuthMiddleware } from "@/middleware/session-auth";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import { SESSION_COOKIE_NAME } from "../constants";

type AppContext = Context<{ Bindings: Env }>;

export const requireSession = sessionAuthMiddleware;

export const logout = async (c: AppContext) => {
  const session = c.get("session");

  if (session) {
    const sessionService = new SessionService(getDb(c.env), c.env.SDP_SESSIONS!);
    await sessionService.revokeSession(session.id);
  }

  // Clear cookie
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
  });

  return success(c, { success: true });
};

export const getCurrentUser = async (c: AppContext) => {
  const session = c.get("session");

  if (!session) {
    throw new AppError("UNAUTHORIZED");
  }

  // Get user details
  const user = await getDb(c.env)
    .prepare("SELECT id, email, name, last_login_at, login_count FROM users WHERE id = ?")
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
  const orgMembership = await getDb(c.env)
    .prepare(
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
};

export const listSessions = async (c: AppContext) => {
  const session = c.get("session");

  if (!session) {
    throw new AppError("UNAUTHORIZED");
  }

  const sessionService = new SessionService(getDb(c.env), c.env.SDP_SESSIONS!);
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
};

export const revokeSession = async (c: AppContext) => {
  const { sessionId } = c.req.param();
  const currentSession = c.get("session");

  if (!currentSession) {
    throw new AppError("UNAUTHORIZED");
  }

  const sessionService = new SessionService(getDb(c.env), c.env.SDP_SESSIONS!);

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
};
