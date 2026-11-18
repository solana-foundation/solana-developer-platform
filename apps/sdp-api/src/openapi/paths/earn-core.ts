import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { operationResponseSchema } from "@sdp/types/operations";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  earnDiscoveryResponseSchema,
  earnPositionsResponseSchema,
} from "@/openapi/schemas/earn-core";
import {
  earnDiscoveryQuerySchema,
  earnPositionsQuerySchema,
} from "@/routes/earn/core/read-schemas";
import { prepareEarnDepositSchema, prepareEarnWithdrawalSchema } from "@/routes/earn/core/schemas";
import { earnErrorResponses } from "./earn-errors";
import { EARN_GROUPS } from "./earn-groups";
import {
  DOCS_GROUP,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithDeclaredIdempotencyHeaders,
} from "./helpers";

/** Internal contract only until the replacement public surface receives named security sign-off. */
export function registerEarnCorePaths(registry: OpenAPIRegistry) {
  const security: Array<Record<string, string[]>> = [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
  const common = {
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.core,
    security,
  };
  registry.registerPath({
    ...common,
    method: "get",
    path: "/v1/earn/discovery",
    operationId: "discoverEarnStrategies",
    summary: "Discover strategies",
    description:
      "Lists the curated strategy catalogue with provider and asset filters. Rates are decimal APY fractions, with their provider source and nullable observation time. Adapter capability is separate from live wallet admission; discovery-only rows cannot accept deposits.",
    request: { headers: projectScopeHeaders, query: earnDiscoveryQuerySchema },
    responses: {
      200: { description: "One catalogue page", content: jsonContent(earnDiscoveryResponseSchema) },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });
  registry.registerPath({
    ...common,
    method: "get",
    path: "/v1/earn/positions",
    operationId: "listEarnCorePositions",
    summary: "List positions",
    description:
      "Lists project holdings with one source shape for custody and external wallets. Choose walletId or ownerAddress. discover=true requires one owner and reads supported integrated strategies without importing ownership or inventing acquisition history. Missing live observations stay unavailable. Optional summary covers the full selected scope; costBasisKnown and costBasisCoverage distinguish unknown earnings history. Pending queue shares and intermediate-token balances remain visible.",
    request: { headers: projectScopeHeaders, query: earnPositionsQuerySchema },
    responses: {
      200: {
        description: "One holding page and optional scope summary",
        content: jsonContent(earnPositionsResponseSchema),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });
  const response = successResponseSchema(operationResponseSchema);
  for (const direction of ["deposit", "withdraw"] as const) {
    registry.registerPath({
      ...common,
      method: "post",
      path: `/v1/earn/${direction}`,
      operationId: direction === "deposit" ? "prepareEarnDeposit" : "prepareEarnWithdrawal",
      summary: direction === "deposit" ? "Prepare a deposit" : "Prepare a withdrawal",
      description:
        direction === "deposit"
          ? "Prepares immutable strategy, source and token-amount intent. Returns a durable operation with economic terms and an unsigned transaction or execute action. Preparation never signs, opens custody approval or broadcasts. Explicit operation execute queues the current action for a worker. Reuse the original Idempotency-Key and body after an uncertain response."
          : "Prepares an exit using a positionId and an explicitly denominated amount: all, shares, token or held intermediate. The position determines its strategy and owner. Terms advertise executable instant or delayed options; execute selects an advertised optionId with the exact actionId and version. Preparation never signs, opens custody approval or broadcasts. Queue entry is not payout; track the operation through settlement.",
      request: {
        headers: projectScopeWithDeclaredIdempotencyHeaders({
          key: "required",
          serverErrors: "rerun",
        }),
        body: {
          required: true,
          content: jsonContent(
            direction === "deposit" ? prepareEarnDepositSchema : prepareEarnWithdrawalSchema
          ),
        },
      },
      responses: {
        200: { description: "Previously prepared operation", content: jsonContent(response) },
        202: {
          description: "Prepared operation; explicit execution is required",
          content: jsonContent(response),
        },
        ...earnErrorResponses([400, 401, 403, 404, 409, 422, 429, 500, 501, 503]),
      },
    });
  }
}
