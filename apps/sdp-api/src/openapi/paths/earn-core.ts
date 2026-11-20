import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { operationResponseSchema } from "@sdp/types/operations";
import { successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
import {
  earnDiscoveryResponseSchema,
  earnPositionsResponseSchema,
} from "@/openapi/schemas/earn-core";
import { EARN_EXAMPLE_IDS, EARN_OWNER_ADDRESS_EXAMPLE } from "@/openapi/schemas/earn-examples";
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

/** Shared core contract; publication follows Earn's release channel. */
export function registerEarnCorePaths(registry: OpenAPIRegistry, publicOnly = false) {
  const security: Array<Record<string, string[]>> = publicOnly
    ? [{ apiKeyAuth: [] }]
    : [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
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
      "Lists the strategies you can deposit into, with their rates and capabilities. rate.value is the provider-reported APY as a decimal fraction; null means unknown, not zero. capabilities.deposit is false for discovery-only rows, and preparation still checks admission live for each wallet.",
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
      "Lists positions, filtered by ownerAddress; the wallet needs no registration in SDP. Without a filter, the page covers every position the key can see, and sourceType=address or sourceType=wallet narrows it. walletId filters to one SDP custody wallet instead. discover=true, with one owner filter, adds holdings in integrated strategies that SDP did not open, without importing ownership or inventing acquisition history. Unavailable live reads stay unavailable, never zero. includeSummary=true totals the whole selected scope; costBasisKnown and costBasisCoverage mark unknown earnings history. Pending queue shares and intermediate-token balances stay visible.",
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
          ? "Prepares a deposit and returns an operation to review, sign and submit. Send strategyId, source.ownerAddress and the amount; the wallet needs no registration in SDP. nextAction sign_transaction carries the unsigned transaction: sign its exact message in the owner's wallet, then send signedTransaction with actionId and version to POST /v1/operations/{operationId}/submit. Preparation never signs or broadcasts. Funding with another token puts the swap and the deposit in one transaction; a pair too large for one transaction is refused before signing, never split. An SDP custody wallet can use source.walletId instead: nextAction is then submit, and SDP requests the signature from its custody provider. After an uncertain response, retry with the original Idempotency-Key and body."
          : "Prepares a withdrawal from a position and returns an operation to review, sign and submit. The position fixes the strategy and owner; amount.kind is all, shares, token or intermediate. When the strategy offers more than one exit route, nextAction is select_option: call POST /v1/operations/{operationId}/refresh with an advertised optionId to prepare that route's transaction, then review and submit its new actionId and version. With amount.kind all, an expired solver escrow can advertise a recovery option even at a zero share balance; it prepares a new transaction that returns the escrowed shares and leaves the original withdrawal unchanged. Hastra par cancellation is not supported, because its reusable request is not bound to a cycle. Preparation never signs or broadcasts, and a queued request is not a payout: track the operation through settlement.",
      request: {
        headers: projectScopeWithDeclaredIdempotencyHeaders({
          key: "required",
          serverErrors: "rerun",
          committedServerErrors: "store",
        }),
        body: {
          required: true,
          content: jsonContent(
            withOpenApi(
              direction === "deposit" ? prepareEarnDepositSchema : prepareEarnWithdrawalSchema,
              {
                example:
                  direction === "deposit"
                    ? {
                        strategyId: EARN_EXAMPLE_IDS.strategy,
                        source: { ownerAddress: EARN_OWNER_ADDRESS_EXAMPLE },
                        amount: {
                          mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                          value: "100",
                        },
                      }
                    : { positionId: EARN_EXAMPLE_IDS.position, amount: { kind: "all" } },
              }
            )
          ),
        },
      },
      responses: {
        200: { description: "Previously prepared operation", content: jsonContent(response) },
        202: {
          description: "Prepared operation; review, sign and submit the returned action",
          content: jsonContent(response),
        },
        ...earnErrorResponses([400, 401, 403, 404, 409, 422, 429, 500, 501, 503]),
      },
    });
  }
}
