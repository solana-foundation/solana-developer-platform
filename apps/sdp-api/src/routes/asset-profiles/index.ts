import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
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

assetProfiles.get("/field-options", requireAction("issuance.read"), getAssetProfileFieldOptions);
assetProfiles.get("/", requireAction("issuance.read"), listAssetProfiles);
assetProfiles.post(
  "/",
  requireAction("issuance.manage"),
  validateBody(createTokenWithAssetProfileSchema),
  createTokenWithAssetProfile
);
assetProfiles.get("/by-token/:tokenId", requireAction("issuance.read"), getAssetProfileByTokenId);
assetProfiles.get("/:profileId", requireAction("issuance.read"), getAssetProfile);
assetProfiles.patch(
  "/:profileId",
  requireAction("issuance.manage"),
  validateBody(updateAssetProfileSchema),
  updateAssetProfile
);
assetProfiles.delete("/:profileId", requireAction("issuance.manage"), archiveAssetProfile);
