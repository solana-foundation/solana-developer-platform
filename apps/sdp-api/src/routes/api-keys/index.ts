/**
 * API Keys Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
} from "./handlers";
import {
  apiKeyCreateSchema,
  apiKeyRevokeSchema,
  apiKeyRotateSchema,
  apiKeyUpdateSchema,
} from "./schemas";

const apiKeys = new Hono<{ Bindings: Env }>();

// All routes require authentication
apiKeys.use("*", unifiedAuthMiddleware());
apiKeys.use("*", projectContextMiddleware());

apiKeys.get("/", requirePermissions("api-keys:read"), listApiKeys);
apiKeys.post(
  "/",
  requirePermissions("api-keys:write"),
  validateBody(apiKeyCreateSchema),
  createApiKey
);
apiKeys.get("/:keyId", requirePermissions("api-keys:read"), getApiKey);
apiKeys.patch(
  "/:keyId",
  requirePermissions("api-keys:write"),
  validateBody(apiKeyUpdateSchema),
  updateApiKey
);
apiKeys.post(
  "/:keyId/rotate",
  requirePermissions("api-keys:write"),
  validateBody(apiKeyRotateSchema),
  rotateApiKey
);
apiKeys.delete(
  "/:keyId",
  requirePermissions("api-keys:write"),
  validateBody(apiKeyRevokeSchema),
  revokeApiKey
);

export default apiKeys;
