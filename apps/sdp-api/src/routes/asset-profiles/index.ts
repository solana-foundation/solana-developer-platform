import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
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

const assetProfiles = new Hono<{ Bindings: Env }>();

// Gate the whole family behind the Asset Profiles feature flag until it is ready
// for prime time. Off by default; enable per-environment via ASSET_PROFILES_ENABLED.
async function requireAssetProfilesFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAssetProfilesEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Asset Profiles are not enabled for this environment");
  }
  await next();
}

assetProfiles.use("*", requireAssetProfilesFeature);
assetProfiles.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
assetProfiles.use("*", projectContextMiddleware());

assetProfiles.get("/field-options", requirePermissions("tokens:read"), getAssetProfileFieldOptions);
assetProfiles.get("/", requirePermissions("tokens:read"), listAssetProfiles);
assetProfiles.post("/", requirePermissions("tokens:write"), createTokenWithAssetProfile);
assetProfiles.get(
  "/by-token/:tokenId",
  requirePermissions("tokens:read"),
  getAssetProfileByTokenId
);
assetProfiles.get("/:profileId", requirePermissions("tokens:read"), getAssetProfile);
assetProfiles.patch("/:profileId", requirePermissions("tokens:write"), updateAssetProfile);
assetProfiles.delete("/:profileId", requirePermissions("tokens:write"), archiveAssetProfile);

export default assetProfiles;
