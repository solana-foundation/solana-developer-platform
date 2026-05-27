/**
 * API Keys Routes
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createApiKey,
  getApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
} from "./handlers";

const apiKeys = new Hono<{ Bindings: Env }>();

// All routes require authentication
apiKeys.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
apiKeys.use("*", projectContextMiddleware());

apiKeys.get("/", requirePermissions("api-keys:read"), listApiKeys);
apiKeys.post("/", requirePermissions("api-keys:write"), createApiKey);
apiKeys.get("/:keyId", requirePermissions("api-keys:read"), getApiKey);
apiKeys.patch("/:keyId", requirePermissions("api-keys:write"), updateApiKey);
apiKeys.post("/:keyId/rotate", requirePermissions("api-keys:write"), rotateApiKey);
apiKeys.delete("/:keyId", requirePermissions("api-keys:write"), revokeApiKey);

export default apiKeys;
