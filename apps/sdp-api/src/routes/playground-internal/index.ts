import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { requireProjectId } from "@/lib/auth";
import { badRequest, forbidden, unauthorized } from "@/lib/errors";
import { noContent } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { ApiKeyService } from "@/services/api-key.service";
import type { Env } from "@/types/env";

const verifyApiKeySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^sk_(test|live)_[A-Za-z0-9_-]+$/),
});

const playgroundInternal = new Hono<{ Bindings: Env }>();

playgroundInternal.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
playgroundInternal.use("*", async (c, next) => {
  if (!c.get("clerk") && !c.get("session")) {
    throw unauthorized("Dashboard session required");
  }
  await next();
});
playgroundInternal.use("*", projectContextMiddleware());

// Metered: each call hashes a caller-supplied key against the DB, which
// would otherwise be an unthrottled credential-testing oracle for dashboard
// sessions.
playgroundInternal.post(
  "/api-key/verify",
  requirePermissions("api-keys:read"),
  meteredQuota({ name: "playground-verify", actorMax: 60, orgMax: 240 }),
  async (c) => {
    const parsed = verifyApiKeySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      throw badRequest("Invalid API key");
    }

    const actor = c.get("clerk") ?? c.get("session");
    if (!actor) {
      throw unauthorized("Dashboard session required");
    }

    const owned = await new ApiKeyService(getDb(c.env), getRequestTenantScope(c)).ownsUsableApiKey({
      apiKey: parsed.data.apiKey,
      organizationId: actor.organizationId,
      projectId: requireProjectId(c),
      pepper: c.env.API_KEY_PEPPER,
    });

    if (!owned) {
      throw forbidden("API key is not available for the selected project");
    }

    return noContent(c);
  }
);

export default playgroundInternal;
