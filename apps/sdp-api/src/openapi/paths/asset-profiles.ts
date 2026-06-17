import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  assetProfileIdParamSchema,
  createAssetProfileRequestSchema,
  errorResponseSchema,
  listAssetProfilesQuerySchema,
  publicTokenMetadataSchema,
  solanaAddressSchema,
  updateAssetProfileRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import {
  assetProfileFieldOptionsResponse,
  assetProfileResponse,
  listAssetProfilesResponse,
} from "./responses";

export function registerAssetProfilePaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/asset-profiles/metadata",
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
    path: "/v1/asset-profiles",
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
    path: "/v1/asset-profiles",
    tags: ["Asset Profiles"],
    summary: "Create asset profile",
    operationId: "createAssetProfile",
    description:
      "Creates an asset profile for an issued token. The token must belong to the caller's project and must not already have an active profile. Public metadata is derived from the supplied issuance metadata via the asset type's projection rules.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(createAssetProfileRequestSchema),
      },
    },
    responses: {
      201: {
        description: "Asset profile created",
        content: jsonContent(assetProfileResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/asset-profiles/{profileId}",
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
    path: "/v1/asset-profiles/{profileId}",
    tags: ["Asset Profiles"],
    summary: "Update asset profile",
    operationId: "updateAssetProfile",
    description:
      "Updates an asset profile. At least one field must be provided. The resulting category/type pair must be supported. Public metadata is recomputed when metadata or the asset type changes.",
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
    path: "/v1/asset-profiles/{profileId}",
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

  registry.registerPath({
    method: "get",
    path: "/token-metadata/{mintAddress}",
    tags: ["Asset Profiles"],
    summary: "Get public token metadata",
    operationId: "getPublicTokenMetadata",
    description:
      "Public, unauthenticated token metadata URI hosted by SDP. Returns only the safe public metadata subset for a deployed token's mint address. Never exposes private compliance or custom fields.",
    responses: {
      200: {
        description: "Public token metadata document",
        content: jsonContent(publicTokenMetadataSchema),
      },
      ...errorResponses(errorResponseSchema, [400, 404]),
    },
    request: {
      params: z.object({
        mintAddress: solanaAddressSchema,
      }),
    },
  });
}
