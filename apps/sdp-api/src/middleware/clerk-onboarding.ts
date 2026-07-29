import type { Context, Next } from "hono";
import {
  type ClerkJwtPayload,
  extractBearerToken,
  resolveClerkEmail,
  verifyClerkJwtForRequest,
} from "@/lib/clerk-token";
import { AppError, unauthorized } from "@/lib/errors";
import type { Env } from "@/types/env";

export function clerkOnboardingMiddleware() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const token = extractBearerToken(c);

    if (!token) {
      throw unauthorized("Clerk session required");
    }

    let payload: ClerkJwtPayload;
    try {
      payload = await verifyClerkJwtForRequest(c, token);
    } catch (error) {
      throw new AppError("UNAUTHORIZED", "Invalid Clerk token", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!payload.sub) {
      throw new AppError("UNAUTHORIZED", "Clerk token missing subject");
    }

    if (!payload.org_id) {
      throw new AppError("UNAUTHORIZED", "Clerk token missing organization");
    }

    const email = resolveClerkEmail(payload);
    if (!email) {
      throw new AppError(
        "UNAUTHORIZED",
        "Clerk token has no usable email claim. Check the JWT template: an invalid shortcode is passed through unsubstituted rather than resolved."
      );
    }

    c.set("clerkOnboarding", {
      clerkUserId: payload.sub,
      clerkOrgId: payload.org_id,
      orgSlug: payload.org_slug ?? null,
      orgRole: payload.org_role ?? null,
      email,
    });

    await next();
  };
}
