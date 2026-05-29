import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { errorResponseSchema, projectScopeHeaderSchema, rpcRelayRequestSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { rpcProvidersResponse, rpcRelayResponse } from "./responses";

const rpcHeadersSchema = z.object({
  "x-project-id": projectScopeHeaderSchema.optional(),
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
      headers: rpcHeadersSchema,
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
    path: "/v1/rpc/proxy",
    tags: ["RPC"],
    summary: "Proxy a JSON-RPC request",
    operationId: "proxyRpcRequest",
    description:
      "Proxies a JSON-RPC request to the resolved provider and records telemetry. Provider selection is controlled via organization/project settings.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: rpcHeadersSchema,
      body: {
        required: true,
        content: jsonContent(rpcRelayRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Proxy response",
        content: jsonContent(rpcRelayResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 500, 502]),
    },
  });
}
