import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  assetProfileIdParamSchema,
  createTokenWithAssetProfileRequestSchema,
  errorResponseSchema,
  listAssetProfilesQuerySchema,
  tokenIdParamSchema,
  updateAssetProfileRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import {
  assetProfileFieldOptionsResponse,
  assetProfileResponse,
  listAssetProfilesResponse,
  tokenWithAssetProfileResponse,
} from "./responses";

export function registerAssetProfilePaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/issuance/asset-profiles/field-options",
    tags: ["Asset Profiles"],
    summary: "Get asset profile field options",
    operationId: "getAssetProfileFieldOptions",
    description:
      "Returns the supported asset categories and the asset types available within each, for building an asset profile form.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Asset profile field options",
        content: jsonContent(assetProfileFieldOptionsResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/asset-profiles",
    tags: ["Asset Profiles"],
    summary: "List asset profiles",
    operationId: "listAssetProfiles",
    description: "Lists asset profiles for the authenticated organization and project.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      query: listAssetProfilesQuerySchema,
    },
    responses: {
      200: {
        description: "Asset profiles list",
        content: jsonContent(listAssetProfilesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/issuance/asset-profiles",
    tags: ["Asset Profiles"],
    summary: "Create token with asset profile",
    operationId: "createTokenWithAssetProfile",
    description:
      "Creates an issued token and its asset profile atomically in a single transaction: if either write fails, both roll back, so a token is never persisted without a profile. Requires the Asset Profiles feature to be enabled.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createTokenWithAssetProfileRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Token and asset profile created",
        content: jsonContent(tokenWithAssetProfileResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/asset-profiles/by-token/{tokenId}",
    tags: ["Asset Profiles"],
    summary: "Get asset profile by token",
    operationId: "getAssetProfileByToken",
    description: "Gets the active asset profile for an issued token, if one exists.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        tokenId: tokenIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Asset profile",
        content: jsonContent(assetProfileResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/issuance/asset-profiles/{profileId}",
    tags: ["Asset Profiles"],
    summary: "Get asset profile",
    operationId: "getAssetProfile",
    description: "Gets an asset profile by id.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        profileId: assetProfileIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "Asset profile",
        content: jsonContent(assetProfileResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/issuance/asset-profiles/{profileId}",
    tags: ["Asset Profiles"],
    summary: "Update asset profile",
    operationId: "updateAssetProfile",
    description:
      "Updates an asset profile. At least one field must be provided. The resulting category/type pair must be supported. Public metadata is recomputed when metadata or the asset type changes; set issuanceMetadata.visibility.public to control which fields are exposed (asset.* and chain.decimals only).",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        profileId: assetProfileIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateAssetProfileRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Asset profile updated",
        content: jsonContent(assetProfileResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/issuance/asset-profiles/{profileId}",
    tags: ["Asset Profiles"],
    summary: "Archive asset profile",
    operationId: "archiveAssetProfile",
    description: "Archives an asset profile. Archived profiles are hidden from default lists.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      params: z.object({
        profileId: assetProfileIdParamSchema,
      }),
    },
    responses: {
      204: {
        description: "Asset profile archived",
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });
}
