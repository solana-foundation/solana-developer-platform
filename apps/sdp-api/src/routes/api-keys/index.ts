/**
 * API Keys Routes
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { requireHumanSession } from "@/middleware/human-session";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
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

export const apiKeys = new Hono<{ Bindings: Env }>();

// All routes require authentication, by a signed-in person: an API key is a
// credential, not an administrator, so it cannot manage keys (HOO-2099).
apiKeys.use("*", unifiedAuthMiddleware());
apiKeys.use("*", requireHumanSession());
apiKeys.use("*", projectContextMiddleware());

apiKeys.get("/", requireAction("api_keys.read"), listApiKeys);
apiKeys.post("/", requireAction("api_keys.manage"), validateBody(apiKeyCreateSchema), createApiKey);
apiKeys.get("/:keyId", requireAction("api_keys.read"), getApiKey);
apiKeys.patch(
  "/:keyId",
  requireAction("api_keys.manage"),
  validateBody(apiKeyUpdateSchema),
  updateApiKey
);
apiKeys.post(
  "/:keyId/rotate",
  requireAction("api_keys.manage"),
  validateBody(apiKeyRotateSchema),
  rotateApiKey
);
apiKeys.delete(
  "/:keyId",
  requireAction("api_keys.manage"),
  validateBody(apiKeyRevokeSchema),
  revokeApiKey
);
