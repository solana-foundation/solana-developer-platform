import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { errorResponseSchema, rpcRelayRequestSchema } from "../schemas";
import { errorResponses, jsonContent, projectScopeHeaders } from "./helpers";
import { rpcRelayResponse } from "./responses";

export function registerRpcPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/rpc/proxy",
    tags: ["RPC"],
    summary: "Proxy a JSON-RPC request",
    operationId: "proxyRpcRequest",
    description:
      "Proxies a JSON-RPC request to SDP's managed RPC pool, which picks the upstream provider round-robin.",
    security: [{ apiKeyAuth: [] }],
    request: {
      headers: projectScopeHeaders,
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
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 413, 429, 500, 502, 504]),
    },
  });
}
