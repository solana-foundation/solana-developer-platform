import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, projectIdParamSchema, rpcRelayRequestSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { rpcProvidersResponse, rpcRelayResponse } from "./responses";

const rpcQuerySchema = z.object({
  projectId: projectIdParamSchema.optional(),
});

export function registerRpcPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/rpc/providers",
    tags: ["RPC"],
    summary: "List relay providers and stats",
    operationId: "listRpcProviders",
    description:
      "Lists managed RPC providers, aggregated telemetry, and the currently selected provider for the caller/project context.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: rpcQuerySchema,
    },
    responses: {
      200: {
        description: "RPC provider list",
        content: jsonContent(rpcProvidersResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/rpc/relay",
    tags: ["RPC"],
    summary: "Relay a JSON-RPC request",
    operationId: "relayRpcRequest",
    description:
      "Forwards a JSON-RPC request to the resolved provider (project preference or default round-robin) and records relay telemetry.",
    security: [{ apiKeyAuth: [] }],
    request: {
      query: rpcQuerySchema,
      body: {
        required: true,
        content: jsonContent(rpcRelayRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Relay response",
        content: jsonContent(rpcRelayResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });
}
