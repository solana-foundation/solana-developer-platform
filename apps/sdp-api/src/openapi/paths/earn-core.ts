import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { operationResponseSchema } from "@sdp/types/operations";
import { successResponseSchema, withOpenApi } from "@/openapi/schemas/base";
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
      "Lists the validated strategy catalogue with provider and asset filters. Rates are decimal APY fractions, with their provider source and nullable observation time. Adapter capability is separate from live wallet admission; discovery-only rows cannot accept deposits.",
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
      "Lists holdings for ownerAddress without requiring a wallet registered in SDP. Use walletId instead for an existing connected wallet. sourceType=wallet selects configured wallets; sourceType=address selects owner-address holdings. Omit sourceType to include both authorized scopes. discover=true requires one owner and reads supported integrated strategies without importing ownership or inventing acquisition history. Missing live observations stay unavailable. Optional summary covers the full selected scope; costBasisKnown and costBasisCoverage distinguish unknown earnings history. Pending queue shares and intermediate-token balances remain visible.",
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
          ? "Prepares a deposit using an SDP API key, strategyId, source.ownerAddress and token amount. No SDP wallet registration or provider connection is required. Returns an operation with terms and nextAction sign_transaction containing the unsigned transaction. Sign its exact message with your own wallet, then send signedTransaction with actionId/version to POST /v1/operations/{operationId}/submit. An existing connected wallet may use source.walletId instead; its nextAction submit requests signing through the configured provider. Preparation never signs or broadcasts. Swap-funded deposits compose both legs atomically; an oversized composition is refused before signing rather than split. Reuse the original Idempotency-Key and body after an uncertain response."
          : "Prepares an exit using a positionId and an explicitly denominated amount: all, shares, token or held intermediate. The position determines its strategy and owner; an owner-address position needs no SDP wallet registration. Sign the returned transaction in that owner's wallet and send signedTransaction to the operation submit endpoint. Connected-wallet positions use their configured signing provider instead. Terms advertise supported direct or delayed options. With amount.kind all, an expired solver escrow may advertise an explicit recovery option even when wallet share balance is zero. Selecting it prepares a new share-return transaction; the original withdrawal remains unchanged. Hastra par cancellation is not supported because its reusable request is not cycle-bound. A multi-route review returns nextAction select_option; operation refresh with the current actionId, version and advertised optionId prepares the selected transaction. Review and submit its new actionId/version separately. Preparation never signs or broadcasts. Queue entry is not payout; track the operation through settlement.",
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
                        strategyId: "strategy_example",
                        source: { ownerAddress: "<owner-public-key>" },
                        amount: {
                          mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                          value: "100",
                        },
                      }
                    : { positionId: "position_example", amount: { kind: "all" } },
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
