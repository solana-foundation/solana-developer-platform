import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  earnExternalWalletEarningsParamsSchema,
  earnExternalWalletMovementParamsSchema,
  earnExternalWalletMovementsQuerySchema,
  earnExternalWalletPositionParamsSchema,
  earnExternalWalletPositionsQuerySchema,
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
  earnExternalWalletWithdrawalResponse,
  earnExternalWalletWithdrawalTransactionRequest,
  earnExternalWalletWithdrawalTransactionResponse,
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
  registerEarnExternalWalletPaths(registry, earnConfigurationSecurity);
}

/** Only the partner-facing caller-signed money routes belong in the public document. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnExternalWalletPaths(registry, earnPublicSecurity);
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
      "Polls one recorded movement to a terminal state — the read that settles a submit whose " +
      "outcome the caller never learned. The reconciliation sweep drives every movement " +
      "terminal within about ninety seconds; keep polling until `finalized` or `failed`.",
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
