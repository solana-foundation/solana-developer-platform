import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  earnButtonConfigurationPublicParamsSchema,
  earnButtonConfigurationSchema,
  earnExternalWalletPositionParamsSchema,
  earnExternalWalletPositionsQuerySchema,
} from "@/routes/earn/schemas";
import { errorResponseSchema } from "../schemas/base";
import {
  earnButtonConfigurationResponse,
  earnExternalWalletDepositResponse,
  earnExternalWalletDepositTransactionRequest,
  earnExternalWalletDepositTransactionResponse,
  earnExternalWalletPositionSummaryResponse,
  earnExternalWalletPositionsResponse,
  earnExternalWalletSubmitRequest,
  earnExternalWalletWithdrawalResponse,
  earnExternalWalletWithdrawalTransactionRequest,
  earnExternalWalletWithdrawalTransactionResponse,
  publicEarnButtonConfigurationResponse,
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
  registerEarnButtonConfigurationPaths(registry);
  registerEarnExternalWalletPaths(registry, earnConfigurationSecurity);
}

/** Only the partner-facing caller-signed money routes belong in the public document. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnExternalWalletPaths(registry, earnPublicSecurity);
}

function registerEarnButtonConfigurationPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: "get",
    path: "/v1/earn/button-configurations/public/{publicToken}",
    tags: ["Earn"],
    summary: "Get a public Earn button handoff",
    operationId: "getPublicEarnButtonConfiguration",
    description:
      "Resolves the style and strategy for an engineering handoff token without exposing tenant metadata or credentials.",
    request: {
      params: earnButtonConfigurationPublicParamsSchema,
    },
    responses: {
      200: {
        description: "Public Earn button handoff",
        content: jsonContent(publicEarnButtonConfigurationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/button-configurations/current",
    tags: ["Earn"],
    summary: "Get the current Earn button configuration",
    operationId: "getEarnButtonConfiguration",
    description:
      "Gets the saved Earn button configuration for the active organization and project.",
    security: earnConfigurationSecurity,
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Earn button configuration",
        content: jsonContent(earnButtonConfigurationResponse),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 429, 500]),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/earn/button-configurations/current",
    tags: ["Earn"],
    summary: "Save the current Earn button configuration",
    operationId: "upsertEarnButtonConfiguration",
    description:
      "Validates deposit availability before saving the selected strategy and appearance for the active organization and project.",
    security: earnConfigurationSecurity,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnButtonConfigurationSchema),
      },
    },
    responses: {
      200: {
        description: "Earn button configuration saved",
        content: jsonContent(earnButtonConfigurationResponse),
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
