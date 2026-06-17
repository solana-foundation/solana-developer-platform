import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  archiveAssetProfile,
  createAssetProfile,
  getAssetProfile,
  getAssetProfileFieldOptions,
  listAssetProfiles,
  updateAssetProfile,
} from "./handlers";

const assetProfiles = new Hono<{ Bindings: Env }>();

assetProfiles.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
assetProfiles.use("*", projectContextMiddleware());

assetProfiles.get("/metadata", requirePermissions("tokens:read"), getAssetProfileFieldOptions);
assetProfiles.get("/", requirePermissions("tokens:read"), listAssetProfiles);
assetProfiles.post("/", requirePermissions("tokens:write"), createAssetProfile);
assetProfiles.get("/:profileId", requirePermissions("tokens:read"), getAssetProfile);
assetProfiles.patch("/:profileId", requirePermissions("tokens:write"), updateAssetProfile);
assetProfiles.delete("/:profileId", requirePermissions("tokens:write"), archiveAssetProfile);

export default assetProfiles;
