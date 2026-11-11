import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { earnProviderActionSchema } from "@sdp/types/earn-provider-orders";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import * as requests from "@/routes/earn/provider-actions/schemas";
import { EARN_GROUPS } from "./earn-groups";
import {
  DOCS_GROUP,
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

/** Internal until an explicit security review promotes these money operations. */
export function registerEarnProviderActionPaths(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  const operations = [
    [
      "preparations",
      "prepareEarnVaultAccount",
      "Prepare a custody vault share account",
      requests.custodyPreparationSchema,
      "earn.execute",
    ],
    [
      "cancellations",
      "cancelEarnProviderOrder",
      "Cancel a custody provider redemption",
      requests.custodyCancellationSchema,
      "earn.manage",
    ],
    [
      "external/preparation-transactions",
      "buildExternalEarnVaultPreparation",
      "Build an external-wallet account preparation",
      requests.externalPreparationSchema,
      "earn.execute",
    ],
    [
      "external/cancellation-transactions",
      "buildExternalEarnProviderCancellation",
      "Build an external-wallet provider cancellation",
      requests.externalCancellationSchema,
      "earn.manage",
    ],
    [
      "external/preparations",
      "submitExternalEarnVaultPreparation",
      "Submit an external-wallet account preparation",
      requests.providerActionSubmitSchema,
      "earn.execute",
    ],
    [
      "external/cancellations",
      "submitExternalEarnProviderCancellation",
      "Submit an external-wallet provider cancellation",
      requests.providerActionSubmitSchema,
      "earn.manage",
    ],
  ] as const;
  const response = successResponseSchema(z.object({ action: earnProviderActionSchema }));
  for (const [path, operationId, summary, body, action] of operations)
    registry.registerPath({
      method: "post",
      path: `/v1/earn/provider-actions/${path}`,
      operationId,
      summary,
      tags: ["Earn"],
      [DOCS_GROUP]: EARN_GROUPS.providerActions,
      security,
      description: `Requires ${action} and an Idempotency-Key. Reuse the same key and payload after uncertain outcomes. Builds return a base64 VersionedTransaction requiring the owner and optional fee payer signatures. Submit the exact message with all existing protocol signatures preserved. Preparation must be finalized or not_required before a sponsored first mint. Cancellation uses the recorded original order and cancels the provider's aggregate pending standard redemption for that wallet and vault; finalization requires verified share return. A confirmed source transaction alone never proves fulfillment.`,
      request: {
        headers: projectScopeWithRequiredIdempotencyHeaders,
        body: { required: true, content: jsonContent(body) },
      },
      responses: {
        200: { description: "Durable provider action", content: jsonContent(response) },
        ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 429, 500, 503]),
      },
    });
  registry.registerPath({
    method: "get",
    path: "/v1/earn/provider-actions/{actionId}",
    operationId: "getEarnProviderAction",
    summary: "Read a provider action",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.providerActions,
    security,
    description:
      "Requires earn.read. Scoped to the authenticated project and environment. Preparation is not_required when its share account already exists, otherwise finalizes at Solana finality; cancellation awaits a verified share return. No additional claim transaction is required.",
    request: { headers: projectScopeHeaders, params: requests.providerActionParamsSchema },
    responses: {
      200: { description: "Provider action", content: jsonContent(response) },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 422, 429, 500, 503]),
    },
  });
}
