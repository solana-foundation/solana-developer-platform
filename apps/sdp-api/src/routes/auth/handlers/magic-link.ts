import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { createEmailService } from "@/services/email";
import { renderMagicLinkEmail } from "@/services/email/templates/magic-link";
import { MagicLinkService } from "@/services/magic-link.service";
import { SessionService } from "@/services/session.service";
import type { Env } from "@/types/env";
import type { OrganizationRole, SendMagicLinkResponse, VerifyMagicLinkResponse } from "@sdp/types";
import { getPermissionsForOrgRole } from "@sdp/types";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import { COOKIE_MAX_AGE_SECONDS, SESSION_COOKIE_NAME } from "../constants";
import { sendMagicLinkSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const sendMagicLink = async (c: AppContext) => {
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

  if (c.env.ENVIRONMENT === "development") {
    console.log(`[DEV] Magic link token for ${email}: ${token}`);
  }

  const verifyUrl = buildMagicLinkUrl(c, token);

  try {
    const emailService = createEmailService(c.env);
    const { html, text, subject } = await renderMagicLinkEmail({ verifyUrl, expiresAt });
    await emailService.sendEmail({ to: [email], subject, html, text });
  } catch (error) {
    console.error("Failed to send magic link email:", error);
  }

  const response: SendMagicLinkResponse = {
    success: true,
    message: "If an account exists for this email, a magic link has been sent.",
    expiresAt,
  };

  return success(c, response);
};

function buildMagicLinkUrl(c: AppContext, token: string): string {
  const frontendUrl = c.env.FRONTEND_URL?.replace(/\/$/, "");
  if (frontendUrl) {
    return `${frontendUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  }

  const originHeader = c.req.header("Origin");
  if (originHeader) {
    return `${originHeader.replace(/\/$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
  }

  const referer = c.req.header("Referer");
  if (referer) {
    try {
      const origin = new URL(referer).origin;
      return `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
    } catch {
      // Ignore invalid referer
    }
  }

  const origin = new URL(c.req.url).origin;
  return `${origin}/v1/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
}

export const verifyMagicLink = async (c: AppContext) => {
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
    maxAge: COOKIE_MAX_AGE_SECONDS,
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
};
