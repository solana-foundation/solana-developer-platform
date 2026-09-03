import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  earnExternalWalletEarningsParamsSchema,
  earnExternalWalletMovementParamsSchema,
  earnExternalWalletMovementsQuerySchema,
  earnExternalWalletPositionParamsSchema,
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
  earnVaultDepositPreviewRequest,
  earnVaultDepositPreviewResponse,
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
  registerEarnDepositPreviewPath(registry, earnConfigurationSecurity);
  registerEarnExternalWalletPaths(registry, earnConfigurationSecurity);
}

/** The discover, quote, build, submit, and read loop exposed to partner backends. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnStrategyPaths(registry, earnPublicSecurity);
  registerEarnDepositPreviewPath(registry, earnPublicSecurity);
  registerEarnExternalWalletPaths(registry, earnPublicSecurity);
}

function registerEarnStrategyPaths(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  registry.registerPath({
    method: "get",
    path: "/v1/earn/strategies",
    tags: ["Earn"],
    summary: "List Embedded Yield strategies",
    operationId: "listEarnStrategies",
    description:
      "Lists the strategies visible to the active project. The default cluster matches the " +
      "API key's project; pass `cluster` only to browse another cluster. Check `fundable` and " +
      "use a mint from `depositMints` before building a deposit. Requires `earn:read`.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: listEarnStrategiesQuerySchema,
    },
    responses: {
      200: {
        description: "Visible Embedded Yield strategies",
        content: jsonContent(earnStrategiesResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/strategies/{strategyId}",
    tags: ["Earn"],
    summary: "Get an Embedded Yield strategy",
    operationId: "getEarnStrategy",
    description:
      "Returns one visible strategy and its live integration metadata. Requires `earn:read`.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnStrategyIdParamsSchema,
    },
    responses: {
      200: {
        description: "Embedded Yield strategy",
        content: jsonContent(earnStrategyResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 503]),
    },
  });
}

function registerEarnDepositPreviewPath(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  registry.registerPath({
    method: "post",
    path: "/v1/earn/vault-deposit-previews",
    tags: ["Earn"],
    summary: "Preview a vault deposit",
    operationId: "createEarnVaultDepositPreview",
    description:
      "Quotes the shares a direct deposit would mint at the provider's current live rate. " +
      "Use the result to derive `minSharesOut`; the preview moves no money and requires " +
      "`earn:read`. A provider without quote support returns 501.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: { required: true, content: jsonContent(earnVaultDepositPreviewRequest) },
    },
    responses: {
      200: {
        description: "Live deposit quote",
        content: jsonContent(earnVaultDepositPreviewResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 501, 503]),
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
    path: "/v1/earn/external-wallet/positions/{ownerAddress}",
    tags: ["Earn"],
    summary: "List one external wallet's positions",
    operationId: "listEarnExternalWalletPositions",
    description:
      "Returns one strict keyset page of live positions for an end-user wallet in the active " +
      "partner project. A wallet outside that scope answers 404. Live fields are absent when " +
      "provider hydration is unavailable, never replaced with zero.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnExternalWalletPositionParamsSchema,
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
      "Polls one recorded movement to a terminal state. Each detail read performs a bounded, " +
      "fail-soft Solana status check so an open client can observe progress immediately. " +
      "Scheduled reconciliation remains the recovery path for closed clients and RPC outages. " +
      "Keep polling until `finalized` or `failed`; no fixed settlement SLA is implied.",
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
    path: "/v1/earn/external-wallet/earnings/{ownerAddress}",
    tags: ["Earn"],
    summary: "Get one external wallet's balance and earnings",
    operationId: "getEarnExternalWalletEarnings",
    description:
      "Returns live balance and total earned per deposit token: `earned` is live value minus " +
      "finalized SDP deposits, stated only when exact. When it cannot be stated — live value " +
      "unavailable, movements still settling, or a finalized withdrawal on a held position — " +
      "the figure is absent with a named reason, never zero. Figures cover currently held " +
      "positions: a fully exited position's history drops out (it stays on the movements " +
      "list). Live value reads the owner's whole vault balance, so shares acquired outside " +
      "SDP inflate it.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnExternalWalletEarningsParamsSchema,
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
    path: "/v1/earn/external-wallet/withdrawal-previews",
    tags: ["Earn"],
    summary: "Preview an external-wallet exit",
    operationId: "createEarnExternalWalletWithdrawalPreview",
    description:
      "Quotes the deposit-token amount an external-wallet position would return at the " +
      "provider's current live rate. Derive `minAmountOut` from this quote and the customer's " +
      "slippage tolerance. The exact project owns the position scope; no custody-wallet " +
      "permission is required. Requires `earn:read`; unsupported providers return 501.",
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
        description: "Live external-wallet withdrawal quote",
        content: jsonContent(earnExternalWalletWithdrawalPreviewResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/deposit-transactions",
    tags: ["Earn"],
    summary: "Build an unsigned external-wallet deposit transaction",
    operationId: "createEarnExternalWalletDepositTransaction",
    description:
      "Builds one unsigned vault deposit transaction for a wallet SDP does not custody. The " +
      "owner is the fee payer and only required signer; the transaction expires with its " +
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
      "Verifies the signed bytes are exactly the built transaction with the owner's genuine " +
      "signature, records the movement, then broadcasts. Requires the Idempotency-Key header: " +
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
