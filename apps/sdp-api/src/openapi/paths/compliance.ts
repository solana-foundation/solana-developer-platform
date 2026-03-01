import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { addressScreeningRequestSchema, errorResponseSchema } from "../schemas";
import { errorResponses, jsonContent } from "./helpers";
import { addressScreeningResponse } from "./responses";

export function registerCompliancePaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "post",
    path: "/v1/compliance/address-screenings",
    tags: ["Compliance"],
    summary: "Screen an address across configured compliance providers",
    operationId: "screenComplianceAddress",
    description:
      "Runs address screening against configured compliance providers and returns provider-level risk scores.",
    security: [{ apiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: jsonContent(addressScreeningRequestSchema),
      },
    },
    responses: {
      200: {
        description: "Address screening results",
        content: jsonContent(addressScreeningResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 500]),
    },
  });
}
