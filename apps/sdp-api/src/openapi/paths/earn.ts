import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  earnExternalWalletEarningsQuerySchema,
  earnExternalWalletMovementParamsSchema,
  earnExternalWalletMovementsQuerySchema,
  earnExternalWalletPositionsQuerySchema,
  earnStrategyIdParamsSchema,
  listEarnStrategiesQuerySchema,
} from "@/routes/earn/schemas";
import { errorResponseSchema } from "../schemas/base";
import {
  earnExternalWalletDepositResponse,
  earnExternalWalletDepositTransactionRequest,
  earnExternalWalletDepositTransactionResponse,
  earnExternalWalletEarningsResponse,
  earnExternalWalletMovementDetailResponse,
  earnExternalWalletMovementsResponse,
  earnExternalWalletPositionSummaryResponse,
  earnExternalWalletPositionsResponse,
  earnExternalWalletSubmitRequest,
  earnExternalWalletWithdrawalPreviewRequest,
  earnExternalWalletWithdrawalPreviewResponse,
  earnExternalWalletWithdrawalResponse,
  earnExternalWalletWithdrawalTransactionRequest,
  earnExternalWalletWithdrawalTransactionResponse,
  earnStrategiesResponse,
  earnStrategyResponse,
} from "../schemas/earn";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

const earnConfigurationSecurity: Array<Record<string, string[]>> = [
  { apiKeyAuth: [] },
  { clerkBearerAuth: [] },
  { sessionCookie: [] },
];

const earnPublicSecurity: Array<Record<string, string[]>> = [{ apiKeyAuth: [] }];

export function registerEarnPaths(registry: OpenAPIRegistry) {
  registerEarnStrategyPaths(registry, earnConfigurationSecurity);
  registerEarnExternalWalletPaths(registry, earnConfigurationSecurity);
}

/** The partner-facing surface: the strategy catalogue plus the caller-signed money routes. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnStrategyPaths(registry, earnPublicSecurity);
  registerEarnExternalWalletPaths(registry, earnPublicSecurity);
}

function registerEarnStrategyPaths(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  // The synced strategy catalogue: where a partner discovers the `strategyId`
  // every deposit build requires, and the live APY its own UI shows.
  registry.registerPath({
    method: "get",
    path: "/v1/earn/strategies",
    tags: ["Earn"],
    summary: "List yield strategies",
    operationId: "listEarnStrategies",
    description:
      "Returns the strategy catalogue visible to the caller, ranked by deposit size (TVL " +
      "descending). By default the list answers the environment's own cluster — the shelf the " +
      "caller can act on; pass `?cluster=` to browse the other cluster's mirrored shelf " +
      "(those rows stay `fundable: false`). Catalogued is not the same as fundable: branch on " +
      "`fundable` and `status` rather than assuming a listed strategy takes deposits.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: listEarnStrategiesQuerySchema,
    },
    responses: {
      200: {
        description: "One page of the strategy catalogue",
        content: jsonContent(earnStrategiesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/strategies/{strategyId}",
    tags: ["Earn"],
    summary: "Get one yield strategy",
    operationId: "getEarnStrategy",
    description:
      "Returns one catalogue row by id, whatever its cluster; `fundable` still answers " +
      "whether the instrument exists on the caller's own cluster.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnStrategyIdParamsSchema,
    },
    responses: {
      200: {
        description: "One strategy-catalogue row",
        content: jsonContent(earnStrategyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });
}

function registerEarnExternalWalletPaths(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  // External-wallet (caller-signed) vault flows (PRO-1722): the B2B2C money
  // path. Each direction is a BUILD (returns an unsigned transaction for the
  // customer's own wallet to sign) and a SUBMIT (verifies the signature over
  // the exact built message, records the movement, then broadcasts).
  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/positions/summary",
    tags: ["Earn"],
    summary: "Get external-wallet position totals",
    operationId: "getEarnExternalWalletPositionSummary",
    description:
      "Returns a complete live aggregate across the active partner project's end-user wallets, " +
      "grouped by strategy and token. The service pages every stored claim before hydration. " +
      "A total is omitted when any contributing live value is unavailable, never reported as zero or partial.",
    security,
    request: { headers: projectScopeHeaders },
    responses: {
      200: {
        description: "Complete external-wallet position aggregate",
        content: jsonContent(earnExternalWalletPositionSummaryResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/positions",
    tags: ["Earn"],
    summary: "List one external wallet's positions",
    operationId: "listEarnExternalWalletPositions",
    description:
      "Returns one strict keyset page of live positions for an end-user wallet in the active " +
      "partner project. `ownerAddress` is required — the same query addressing every per-owner " +
      "read on this surface uses. A wallet outside the project's scope answers 404. Live " +
      "fields are absent when provider hydration is unavailable, never replaced with zero.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletPositionsQuerySchema,
    },
    responses: {
      200: {
        description: "External-wallet position page",
        content: jsonContent(earnExternalWalletPositionsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/movements",
    tags: ["Earn"],
    summary: "List one external wallet's activity",
    operationId: "listEarnExternalWalletMovements",
    description:
      "Returns one keyset page of the wallet's recorded deposits and withdrawals, newest " +
      "first, in ledger vocabulary (`requested`, `submitted`, `confirmed`, `finalized`, " +
      "`failed`; only `finalized` and `failed` are terminal). `ownerAddress` is required; a " +
      "wallet outside the active partner project answers 404. Reports on money that already " +
      "moved, so no provider gate applies.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletMovementsQuerySchema,
    },
    responses: {
      200: {
        description: "External-wallet movement page",
        content: jsonContent(earnExternalWalletMovementsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/movements/{movementId}",
    tags: ["Earn"],
    summary: "Get one external-wallet movement",
    operationId: "getEarnExternalWalletMovement",
    description:
      "Polls one recorded movement to a terminal state — the read that settles a submit whose " +
      "outcome the caller never learned. Each poll observes the movement's exact signature on " +
      "chain and advances the recorded status immediately, so state lands as fast as the " +
      "network decides it; if the chain read is unavailable the last durable status is served " +
      "and a background reconciler (about every minute) remains the recovery path. Keep " +
      "polling until `finalized` or `failed` — those are the only terminal states.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnExternalWalletMovementParamsSchema,
    },
    responses: {
      200: {
        description: "Recorded movement",
        content: jsonContent(earnExternalWalletMovementDetailResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/earnings",
    tags: ["Earn"],
    summary: "Get one external wallet's balance and earnings",
    operationId: "getEarnExternalWalletEarnings",
    description:
      "Returns live balance and total earned per deposit token for the required " +
      "`ownerAddress`: `earned` is live value minus " +
      "finalized SDP deposits, stated only when exact. When it cannot be stated — live value " +
      "unavailable, movements still settling, or a finalized withdrawal on a held position — " +
      "the figure is absent with a named reason, never zero. Figures cover currently held " +
      "positions: a fully exited position's history drops out (it stays on the movements " +
      "list). Live value reads the owner's whole vault balance, so shares acquired outside " +
      "SDP inflate it.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletEarningsQuerySchema,
    },
    responses: {
      200: {
        description: "External-wallet earnings",
        content: jsonContent(earnExternalWalletEarningsResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/deposit-transactions",
    tags: ["Earn"],
    summary: "Build an unsigned external-wallet deposit transaction",
    operationId: "createEarnExternalWalletDepositTransaction",
    description:
      "Builds one unsigned vault deposit transaction for a wallet SDP does not custody. By " +
      "default the owner is the fee payer and only required signer; pass `feePayer` to pay " +
      "the network fee (and any first-deposit account rent) from your own wallet instead — " +
      "the transaction then also requires that wallet's signature, added server-side before " +
      "submit. The transaction expires with its " +
      "blockhash, and nothing moves until the signed bytes are submitted.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletDepositTransactionRequest),
      },
    },
    responses: {
      200: {
        description: "Unsigned deposit transaction",
        content: jsonContent(earnExternalWalletDepositTransactionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/deposits",
    tags: ["Earn"],
    summary: "Submit a signed external-wallet deposit",
    operationId: "createEarnExternalWalletDeposit",
    description:
      "Verifies the signed bytes are exactly the built transaction and that every required " +
      "signature is genuine — the owner's, and the fee payer's when the build named one — " +
      "records the movement, then broadcasts. Requires the Idempotency-Key header: " +
      "a retry with the same key resolves the original movement (`replayed: true`), and each " +
      "built transaction is consumable exactly once.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletSubmitRequest),
      },
    },
    responses: {
      200: {
        description: "Recorded deposit movement",
        content: jsonContent(earnExternalWalletDepositResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-previews",
    tags: ["Earn"],
    summary: "Preview an external-wallet exit",
    operationId: "createEarnExternalWalletWithdrawalPreview",
    description:
      "Quotes what redeeming the shares would pay right now, from the vault's live " +
      "accounting — the read a truthful `minAmountOut` floor is derived from (`assetsOut` " +
      "minus your chosen tolerance, quantized to `assetDecimals`). Read-only, no idempotency " +
      "key, and it takes the exit's own gates: a delisted strategy or a provider disabled for " +
      "new deposits stays quotable. POST because the parameters are a body; 501 when the " +
      "provider cannot quote exits.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletWithdrawalPreviewRequest),
      },
    },
    responses: {
      200: {
        description: "Live exit quote",
        content: jsonContent(earnExternalWalletWithdrawalPreviewResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-transactions",
    tags: ["Earn"],
    summary: "Build an unsigned external-wallet exit transaction",
    operationId: "createEarnExternalWalletWithdrawalTransaction",
    description:
      "Builds one unsigned exit transaction for an external-wallet position. Takes no " +
      "surfacing, entitlement, availability, or catalogue gate (ADR 0002 exit safety), so the " +
      "exit works while the provider is disabled for new deposits.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletWithdrawalTransactionRequest),
      },
    },
    responses: {
      200: {
        description: "Unsigned exit transaction",
        content: jsonContent(earnExternalWalletWithdrawalTransactionResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawals",
    tags: ["Earn"],
    summary: "Submit a signed external-wallet withdrawal",
    operationId: "createEarnExternalWalletWithdrawal",
    description:
      "The exit mirror of the deposit submit: signature verified over the exact built message, " +
      "movement recorded before broadcast, Idempotency-Key required, one submission per built " +
      "transaction.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletSubmitRequest),
      },
    },
    responses: {
      200: {
        description: "Recorded withdrawal movement",
        content: jsonContent(earnExternalWalletWithdrawalResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });
}
