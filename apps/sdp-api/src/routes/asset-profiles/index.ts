import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { createTokenWithAssetProfileSchema } from "../issuance/schemas";
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

const assetProfiles = new Hono<{ Bindings: Env }>();

assetProfiles.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
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

export default assetProfiles;
