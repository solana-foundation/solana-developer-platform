import type { Context, Next } from "hono";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";
import { requirePermissions, unifiedAuthMiddleware } from "./auth";

export function credentialAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware({ allowClerk: true });
  const authorize = requirePermissions("custody:admin");

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (c.get("apiKey")) {
        throw forbidden("Credential administration requires Clerk authentication");
      }
      await authorize(c, next);
    });
  };
}
