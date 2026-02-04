import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import type { Context, Next } from "hono";

// Allowlist admin middleware.
// In production, requires either a configured admin key or Clerk org ownership.
export const adminAuth = async (
  c: Context<{ Bindings: Env }>,
  next: Next
) => {
  const adminKey = c.req.header("X-Admin-Key");

  if (c.env.ENVIRONMENT === "development") {
    await next();
    return;
  }

  if (adminKey && c.env.ALLOWLIST_ADMIN_KEY && adminKey === c.env.ALLOWLIST_ADMIN_KEY) {
    await next();
    return;
  }

  const apiKey = c.get("apiKey");
  if (apiKey?.permissions?.includes("*")) {
    await next();
    return;
  }

  const clerk = c.get("clerk");
  if (clerk) {
    const adminOrgId = c.env.ALLOWLIST_ADMIN_ORG_ID;
    const adminOrgSlug = c.env.ALLOWLIST_ADMIN_ORG_SLUG;
    const isOrgMatch =
      (adminOrgId && clerk.organizationId === adminOrgId) ||
      (adminOrgSlug && clerk.orgSlug === adminOrgSlug);

    if (isOrgMatch && (clerk.role === "owner" || clerk.permissions.includes("*"))) {
      await next();
      return;
    }
  }

  throw new AppError("FORBIDDEN", "Admin access required");
};
