import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import {
  apiKeyIdParamSchema,
  createApiKeyRequestSchema,
  errorResponseSchema,
  rotateApiKeyRequestSchema,
  updateApiKeyRequestSchema,
} from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import {
  actionSuccessResponse,
  apiKeyCreateResponse,
  apiKeyDetailResponse,
  apiKeyRevokeResponse,
  apiKeyRotateResponse,
  listApiKeysResponse,
} from "./responses";

export function registerApiKeyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/api-keys",
    tags: ["API Keys"],
    summary: "List API keys",
    operationId: "listApiKeys",
    description: "Lists API keys for the authenticated organization.",
    security: [{ apiKeyAuth: [] }],
    responses: {
      200: {
        description: "API keys",
        content: jsonContent(listApiKeysResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/api-keys",
    tags: ["API Keys"],
    summary: "Create API key",
    operationId: "createApiKey",
    description: "Creates a new API key. The full key is returned once.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(createApiKeyRequestSchema),
      },
    },
    responses: {
      201: {
        description: "API key created",
        content: jsonContent(apiKeyCreateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 409, 500]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/api-keys/{keyId}",
    tags: ["API Keys"],
    summary: "Get API key",
    operationId: "getApiKey",
    description: "Gets API key details by id.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        keyId: apiKeyIdParamSchema,
      }),
    },
    responses: {
      200: {
        description: "API key details",
        content: jsonContent(apiKeyDetailResponse),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/v1/api-keys/{keyId}",
    tags: ["API Keys"],
    summary: "Update API key",
    operationId: "updateApiKey",
    description: "Updates API key attributes. Use null to clear optional fields.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        keyId: apiKeyIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(updateApiKeyRequestSchema),
      },
    },
    responses: {
      200: {
        description: "API key updated",
        content: jsonContent(actionSuccessResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/api-keys/{keyId}/rotate",
    tags: ["API Keys"],
    summary: "Rotate API key",
    operationId: "rotateApiKey",
    description: "Rotates an API key and returns the new key plus the old key grace period.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        keyId: apiKeyIdParamSchema,
      }),
      body: {
        required: false,
        content: jsonContent(rotateApiKeyRequestSchema),
      },
    },
    responses: {
      201: {
        description: "API key rotated",
        content: jsonContent(apiKeyRotateResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/api-keys/{keyId}",
    tags: ["API Keys"],
    summary: "Deactivate API key",
    operationId: "revokeApiKey",
    description: "Deactivates (soft deletes) an API key and invalidates it immediately.",
    security: [{ apiKeyAuth: [] }],
    request: {
      params: z.object({
        keyId: apiKeyIdParamSchema,
      }),
      body: {
        required: true,
        content: jsonContent(
          z.object({
            confirmation: z.string().min(1).openapi({
              description: "Type the exact API key name to confirm deletion.",
              example: "Primary Key",
            }),
          })
        ),
      },
    },
    responses: {
      200: {
        description: "API key revoked",
        content: jsonContent(apiKeyRevokeResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });
}
