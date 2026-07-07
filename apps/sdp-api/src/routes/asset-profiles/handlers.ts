import {
  ASSET_CATEGORIES,
  ASSET_TYPES,
  type AssetProfile,
  type AssetProfileFieldOptionsResponse,
  type AssetProfileResponse,
  getAssetTypeRegistryEntry,
  isAssetTypeSupported,
  type ListAssetProfilesResponse,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import type { AssetProfileRow } from "@/db/repositories/asset-profile.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  badRequest,
  badRequestParams,
  badRequestQuery,
  internalError,
  notFound,
} from "@/lib/errors";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { type AppContext, getAssetProfilesRepository } from "./context";
import {
  assetProfileIdParamsSchema,
  assetProfileTokenIdParamsSchema,
  listAssetProfilesQuerySchema,
  updateAssetProfileSchema,
} from "./schemas";

export function mapToAssetProfile(row: AssetProfileRow): AssetProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    tokenId: row.token_id,
    assetCategory: row.asset_category,
    assetType: row.asset_type,
    assetTypeVersion: row.asset_type_version,
    issuanceMetadata: row.issuance_metadata,
    publicMetadata: row.public_metadata,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const getAssetProfileFieldOptions = async (c: AppContext) => {
  const response: AssetProfileFieldOptionsResponse = {
    fields: {
      categories: ASSET_CATEGORIES,
      types: ASSET_TYPES,
    },
  };
  return success(c, response);
};

export const listAssetProfiles = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listAssetProfilesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, includeArchived, category } = parsed.data;

  const repo = getAssetProfilesRepository(c);
  const { rows, total } = await repo.listAssetProfiles({
    organizationId: auth.organizationId,
    projectId,
    category,
    includeArchived,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListAssetProfilesResponse = {
    assetProfiles: rows.map(mapToAssetProfile),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getAssetProfilesRepository(c);
  const profile = await repo.getAssetProfileById({
    profileId: params.data.profileId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!profile) {
    throw notFound("Asset profile");
  }

  const response: AssetProfileResponse = { assetProfile: mapToAssetProfile(profile) };
  return success(c, response);
};

export const getAssetProfileByTokenId = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileTokenIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getAssetProfilesRepository(c);
  const profile = await repo.getActiveAssetProfileByTokenId({
    tokenId: params.data.tokenId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!profile) {
    throw notFound("Asset profile");
  }

  const response: AssetProfileResponse = { assetProfile: mapToAssetProfile(profile) };
  return success(c, response);
};

export const updateAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = await c.req.json();
  const parsed = updateAssetProfileSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", { errors: z.treeifyError(parsed.error) });
  }

  const { profileId } = params.data;
  const repo = getAssetProfilesRepository(c);

  const current = await repo.getAssetProfileById({
    profileId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!current) {
    throw notFound("Asset profile");
  }

  // Resolve the effective category/type by merging the patch over the existing
  // row, then validate the pair (the schema can only check it when both are sent).
  const nextCategory = parsed.data.assetCategory ?? current.asset_category;
  const nextType = parsed.data.assetType ?? current.asset_type;
  if (!isAssetTypeSupported(nextCategory, nextType)) {
    throw badRequest(`Unsupported assetType "${nextType}" for category "${nextCategory}"`);
  }

  const registryEntry = getAssetTypeRegistryEntry(nextCategory, nextType);
  if (!registryEntry) {
    throw internalError("Missing registry entry for a validated asset type");
  }

  const typeChanged = nextCategory !== current.asset_category || nextType !== current.asset_type;
  const metadataChanged = parsed.data.issuanceMetadata !== undefined;
  const nextMetadata = parsed.data.issuanceMetadata ?? current.issuance_metadata;

  // Recompute the cached public projection whenever its inputs change.
  const publicMetadata =
    typeChanged || metadataChanged
      ? projectPublicMetadata(nextCategory, nextType, nextMetadata)
      : undefined;

  const updated = await repo.updateAssetProfile({
    profileId,
    organizationId: auth.organizationId,
    projectId,
    assetCategory: parsed.data.assetCategory,
    assetType: parsed.data.assetType,
    assetTypeVersion: typeChanged ? registryEntry.version : undefined,
    issuanceMetadata: parsed.data.issuanceMetadata,
    publicMetadata,
  });

  if (!updated) {
    throw notFound("Asset profile");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "asset_profile",
    resourceId: profileId,
    metadata: { changedFields: Object.keys(parsed.data) },
  });

  const response: AssetProfileResponse = { assetProfile: mapToAssetProfile(updated) };
  return success(c, response);
};

export const archiveAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { profileId } = params.data;
  const repo = getAssetProfilesRepository(c);

  const archived = await repo.archiveAssetProfile({
    profileId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    throw notFound("Asset profile");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "asset_profile",
    resourceId: profileId,
  });

  return noContent(c);
};
