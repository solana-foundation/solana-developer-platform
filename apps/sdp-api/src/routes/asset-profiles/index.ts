import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import { createTokenWithAssetProfileSchema } from "@/routes/issuance/schemas";
import type { Env } from "@/types/env";
import { createTokenWithAssetProfile } from "./create";
import {
  archiveAssetProfile,
  getAssetProfile,
  getAssetProfileByTokenId,
  getAssetProfileFieldOptions,
  listAssetProfiles,
  updateAssetProfile,
} from "./handlers";
import { updateAssetProfileSchema } from "./schemas";

export const assetProfiles = new Hono<{ Bindings: Env }>();

assetProfiles.use("*", unifiedAuthMiddleware());
assetProfiles.use("*", projectContextMiddleware());

assetProfiles.get("/field-options", requirePermissions("tokens:read"), getAssetProfileFieldOptions);
assetProfiles.get("/", requirePermissions("tokens:read"), listAssetProfiles);
assetProfiles.post(
  "/",
  requirePermissions("tokens:write"),
  validateBody(createTokenWithAssetProfileSchema),
  createTokenWithAssetProfile
);
assetProfiles.get(
  "/by-token/:tokenId",
  requirePermissions("tokens:read"),
  getAssetProfileByTokenId
);
assetProfiles.get("/:profileId", requirePermissions("tokens:read"), getAssetProfile);
assetProfiles.patch(
  "/:profileId",
  requirePermissions("tokens:write"),
  validateBody(updateAssetProfileSchema),
  updateAssetProfile
);
assetProfiles.delete("/:profileId", requirePermissions("tokens:write"), archiveAssetProfile);
