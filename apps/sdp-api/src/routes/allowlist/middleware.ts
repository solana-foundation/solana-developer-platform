import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

// SHA-256 digests both sides before comparing: equal-length inputs make
// timingSafeEqual run in constant time without leaking the key's length via a
// pre-compare short-circuit.
function adminKeyMatches(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

// Allowlist admin middleware. Guards the platform-wide signup allowlist, so access
// requires an explicit platform-operator credential in every environment: a matching
// X-Admin-Key, or a Clerk session in the designated admin org. Customer API keys never
// qualify — a wildcard "*" key is full access to its own org, not to this resource.
export const adminAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const adminKey = c.req.header("X-Admin-Key");

  if (
    adminKey &&
    c.env.ALLOWLIST_ADMIN_KEY &&
    adminKeyMatches(adminKey, c.env.ALLOWLIST_ADMIN_KEY)
  ) {
    await next();
    return;
  }

  const clerk = c.get("clerk");
  if (clerk) {
    const adminOrgId = c.env.ALLOWLIST_ADMIN_ORG_ID;
    const isOrgMatch = adminOrgId && clerk.organizationId === adminOrgId;

    if (
      isOrgMatch &&
      (clerk.role === "admin" ||
        clerk.permissions.includes("org:admin") ||
        clerk.permissions.includes("*"))
    ) {
      await next();
      return;
    }
  }

  throw new AppError("FORBIDDEN", "Admin access required");
};
