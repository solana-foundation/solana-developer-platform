/** Existing dashboard network snapshot; intentionally absent from public OpenAPI. */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { NETWORK_METRIC_IDS, networkSnapshotSchema } from "@sdp/types/network-metrics";
import { errorResponseSchema, successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
import { errorResponses, jsonContent } from "./helpers";

// Zod 4 enum-keyed records require every key and reject unknown keys. The
// OpenAPI 3 record transformer emits the properties but omits those constraints.
const snapshotSchema = networkSnapshotSchema.extend({
  metrics: withOpenApi(networkSnapshotSchema.shape.metrics, {
    required: [...NETWORK_METRIC_IDS],
    additionalProperties: false,
  }),
});

export function registerDashboardNetworkPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/internal/dashboard/network",
    tags: ["Dashboard Network Data"],
    summary: "Read the dashboard Solana network snapshot",
    operationId: "getDashboardNetworkSnapshot",
    description:
      "Reads the API's cached chain-wide Solana figures: stablecoin supply, daily stablecoin transfers, stablecoin share of successful non-vote transactions (percent), and cost per successful non-vote transaction (USD). Requires a signed-in user's Clerk session; API keys are refused. No tenant action or selected project is required. Accepts no request body, query parameters, or idempotency key. These are mainnet network figures, independent of the selected project's environment. asOf is the shared complete UTC day, and each series contains oldest-first daily points or an empty array when unavailable. Mainnet health carries its own checkedAt timestamp and is null when unavailable. Cached readings may be stale; preserve their timestamps. The CLI makes one request without polling or refreshing the sources directly. DATA_API_KEY and source caches are managed by the API.",
    security: [{ clerkBearerAuth: [] }],
    responses: {
      200: {
        description: "Cached network readings and independently observed mainnet health",
        content: jsonContent(successResponseSchema(snapshotSchema)),
      },
      ...errorResponses(errorResponseSchema, [401, 403, 429, 500, 503]),
    },
  });
}
