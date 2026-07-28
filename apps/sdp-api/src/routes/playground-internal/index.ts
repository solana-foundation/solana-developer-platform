import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { requireProjectId } from "@/lib/auth";
import { badRequest, forbidden, unauthorized } from "@/lib/errors";
import { noContent } from "@/lib/response";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
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

playgroundInternal.post("/api-key/verify", requirePermissions("api-keys:read"), async (c) => {
  const parsed = verifyApiKeySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid API key");
  }

  const actor = c.get("clerk") ?? c.get("session");
  if (!actor) {
    throw unauthorized("Dashboard session required");
  }

  const owned = await new ApiKeyService(getDb(c.env)).ownsUsableApiKey({
    apiKey: parsed.data.apiKey,
    organizationId: actor.organizationId,
    projectId: requireProjectId(c),
    pepper: c.env.API_KEY_PEPPER,
  });

  if (!owned) {
    throw forbidden("API key is not available for the selected project");
  }

  return noContent(c);
});

export default playgroundInternal;
