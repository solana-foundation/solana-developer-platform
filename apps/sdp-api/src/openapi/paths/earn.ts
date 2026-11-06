import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  earnCursorQueryParams,
  earnExternalWalletDepositResponse,
  earnExternalWalletDepositTransactionRequest,
  earnExternalWalletDepositTransactionResponse,
  earnExternalWalletEarningsResponse,
  earnExternalWalletMovementDetailResponse,
  earnExternalWalletMovementsResponse,
  earnExternalWalletPositionSummaryResponse,
  earnExternalWalletPositionsResponse,
  earnExternalWalletQueuedWithdrawalPreviewRequest,
  earnExternalWalletQueuedWithdrawalPreviewResponse,
  earnExternalWalletSubmitRequest,
  earnExternalWalletWithdrawalOptionsRequest,
  earnExternalWalletWithdrawalOptionsResponse,
  earnExternalWalletWithdrawalPreviewRequest,
  earnExternalWalletWithdrawalPreviewResponse,
  earnExternalWalletWithdrawalRequestCancellationResponse,
  earnExternalWalletWithdrawalRequestCancelTransactionRequest,
  earnExternalWalletWithdrawalRequestCancelTransactionResponse,
  earnExternalWalletWithdrawalRequestResponse,
  earnExternalWalletWithdrawalRequestsResponse,
  earnExternalWalletWithdrawalRequestTransactionRequest,
  earnExternalWalletWithdrawalRequestTransactionResponse,
  earnExternalWalletWithdrawalResponse,
  earnExternalWalletWithdrawalTransactionRequest,
  earnExternalWalletWithdrawalTransactionResponse,
  earnMovementIdParam,
  earnMovementStatusQueryParam,
  earnOwnerAddressQueryParam,
  earnStrategiesResponse,
  earnStrategyIdParam,
  earnStrategyResponse,
  earnVaultDepositPreviewRequest,
  earnVaultDepositPreviewResponse,
  earnVaultShareReconciliationResponse,
  earnWithdrawalRequestIdParam,
} from "@/openapi/schemas/earn";
import {
  EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE,
  EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE,
  EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE,
} from "@/openapi/schemas/earn-examples";
import {
  earnExternalWalletEarningsQuerySchema,
  earnExternalWalletMovementParamsSchema,
  earnExternalWalletMovementsQuerySchema,
  earnExternalWalletPositionSummaryQuerySchema,
  earnExternalWalletPositionsQuerySchema,
  earnExternalWalletWithdrawalRequestsQuerySchema,
  earnStrategyIdParamsSchema,
  earnVaultWithdrawalRequestParamsSchema,
  listEarnStrategiesQuerySchema,
} from "@/routes/earn/schemas";
import { earnErrorResponses } from "./earn-errors";
import { EARN_GROUPS } from "./earn-groups";
import { registerEarnTreasuryPaths } from "./earn-treasury";
import {
  DOCS_GROUP,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

type EarnSecurity = Array<Record<string, string[]>>;

const earnConfigurationSecurity: EarnSecurity = [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];

const earnPublicSecurity: EarnSecurity = [{ apiKeyAuth: [] }];

export function registerEarnPaths(registry: OpenAPIRegistry) {
  registerEarnStrategyPaths(registry, earnConfigurationSecurity);
  registerEarnDepositPreviewPath(registry, earnConfigurationSecurity);
  registerEarnExternalWalletPaths(registry, earnConfigurationSecurity);
  registerEarnTreasuryPaths(registry, earnConfigurationSecurity);
  // Treasury-facing, so the internal document only: partners hold no custody
  // wallets for this read to reconcile.
  registerEarnVaultShareReconciliationPath(registry, earnConfigurationSecurity);
}

/** The partner-facing surface: the strategy catalogue plus the caller-signed money routes. */
export function registerPublicEarnPaths(registry: OpenAPIRegistry) {
  registerEarnStrategyPaths(registry, earnPublicSecurity);
  registerEarnDepositPreviewPath(registry, earnPublicSecurity);
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
    [DOCS_GROUP]: EARN_GROUPS.discovery,
    summary: "List strategies",
    operationId: "listEarnStrategies",
    description:
      "Lists the strategies your project can see, largest first by total value locked. The " +
      "list defaults to your project's cluster: devnet for sandbox, mainnet for production. " +
      "Pass `cluster` to browse the other cluster's strategies; those rows are always " +
      "`fundable: false`. A listed strategy is not always open for deposits, so check " +
      "`fundable` and `status` before you offer it.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: listEarnStrategiesQuerySchema,
    },
    responses: {
      200: {
        description: "One page of strategies",
        content: jsonContent(earnStrategiesResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/strategies/{strategyId}",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.discovery,
    summary: "Get a strategy",
    operationId: "getEarnStrategy",
    description:
      "Gets one strategy by ID, on either cluster. `fundable` still reports whether the " +
      "strategy exists on your project's cluster.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnStrategyIdParamsSchema.extend({ strategyId: earnStrategyIdParam }),
    },
    responses: {
      200: {
        description: "The strategy",
        content: jsonContent(earnStrategyResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
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
    [DOCS_GROUP]: EARN_GROUPS.discovery,
    summary: "Preview a deposit",
    operationId: "createEarnVaultDepositPreview",
    description:
      "Quotes how many shares a deposit would receive right now, from the provider's live " +
      "accounting. When the strategy's `depositSlippage` is not null, set `minSharesOut` " +
      "from this quote: take your tolerance off `sharesOut`. Resolve every `blockingIssues` " +
      "entry before you build. The preview is read-only, takes no Idempotency-Key, and " +
      "applies a deposit's access checks, provider activation included. It returns 501 when " +
      "the provider cannot quote deposits.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnVaultDepositPreviewRequest),
      },
    },
    responses: {
      200: {
        description: "Live deposit quote",
        content: jsonContent(earnVaultDepositPreviewResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });
}

function registerEarnVaultShareReconciliationPath(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  registry.registerPath({
    method: "get",
    path: "/v1/earn/vault-share-reconciliation",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.treasury,
    summary: "Reconcile custody shares",
    operationId: "getEarnVaultShareReconciliation",
    description:
      "Report-only comparison of each scoped custody wallet's on-chain share balances against " +
      "the recorded claim set, both directions: share balances of catalogued vaults with no " +
      "recorded position (for example, shares acquired by signing outside SDP), and recorded " +
      "open positions whose wallet holds none of their shares. Writes nothing. Takes the same " +
      "wallet-binding scope as the positions read and no provider gate.",
    security,
    request: {
      headers: projectScopeHeaders,
    },
    responses: {
      200: {
        description: "Reconciliation report",
        content: jsonContent(earnVaultShareReconciliationResponse),
      },
      ...earnErrorResponses([401, 403, 429, 500, 503]),
    },
  });
}

function registerEarnExternalWalletPaths(registry: OpenAPIRegistry, security: EarnSecurity) {
  // External-wallet (caller-signed) vault flows (PRO-1722): the B2B2C money
  // path. Each direction is a BUILD (returns an unsigned transaction for the
  // customer's own wallet to sign) and a SUBMIT (verifies the signature over
  // the exact built message, records the movement, then broadcasts).
  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/positions/summary",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Get position totals",
    operationId: "getEarnExternalWalletPositionSummary",
    description:
      "Gets live position totals across every customer wallet in your project, grouped by " +
      "strategy and token. Wallet addresses are left out unless you pass " +
      "`includeOwnerAddresses=true`; add `includePositions=true` to also receive each " +
      "wallet's positions, which saves one read per wallet. A total that depends on an " +
      "unavailable live value is left out, never reported as zero or partial.",
    security,
    request: { headers: projectScopeHeaders, query: earnExternalWalletPositionSummaryQuerySchema },
    responses: {
      200: {
        description: "Position totals",
        content: jsonContent(earnExternalWalletPositionSummaryResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/positions",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "List positions",
    operationId: "listEarnExternalWalletPositions",
    description:
      "Lists one customer wallet's live positions, one page at a time. `ownerAddress` is " +
      "required. A wallet with no positions in your project (never deposited, fully " +
      "withdrawn, or held under another organization) returns an empty `positions` list, " +
      "not 404. Live fields are left out, never set to zero, when the provider read is " +
      "unavailable.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletPositionsQuerySchema.extend({
        ownerAddress: earnOwnerAddressQueryParam,
        ...earnCursorQueryParams,
      }),
    },
    responses: {
      200: {
        description: "One page of positions",
        content: jsonContent(earnExternalWalletPositionsResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/movements",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "List movements",
    operationId: "listEarnExternalWalletMovements",
    description:
      "Lists one customer wallet's deposits and withdrawals, newest first, one page at a " +
      "time. Movement statuses are `requested`, `submitted`, `confirmed`, `finalized` and " +
      "`failed`; only `finalized` and `failed` are final. `ownerAddress` is required, and a " +
      "wallet with no movements returns an empty `movements` list, not 404. Show " +
      "`tokenAmount` in `tokenMint` units: on a withdrawal it is the observed payout once " +
      "finalized, while `amount` and `denomination` carry the onchain quantity, which is " +
      "shares. Reads keep working after a provider stops taking deposits.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletMovementsQuerySchema.extend({
        ownerAddress: earnOwnerAddressQueryParam,
        status: earnMovementStatusQueryParam,
        ...earnCursorQueryParams,
      }),
    },
    responses: {
      200: {
        description: "One page of movements",
        content: jsonContent(earnExternalWalletMovementsResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/movements/{movementId}",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Get a movement",
    operationId: "getEarnExternalWalletMovement",
    description:
      "Gets one deposit or withdrawal and refreshes its onchain status when it can. Use it " +
      "to track a movement after submit, or to recover a submit whose response was lost. If " +
      "the chain read fails, you get the last recorded status while SDP keeps reconciling " +
      "in the background. An atomic movement can show as done at `confirmed`, but only " +
      "`finalized` and `failed` are final. For `settlement: provider_order`, chain " +
      "confirmation is not payout: the provider still has to complete the order.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnExternalWalletMovementParamsSchema.extend({ movementId: earnMovementIdParam }),
    },
    responses: {
      200: {
        description: "Recorded movement",
        content: jsonContent(earnExternalWalletMovementDetailResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/earnings",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Get earnings",
    operationId: "getEarnExternalWalletEarnings",
    description:
      "Gets one customer wallet's live balance and earnings per deposit token. `earned` is " +
      "live value plus observed withdrawal payouts (`totalWithdrawn`) minus finalized " +
      "deposits (`totalDeposited`), and appears only when it is exact. Otherwise it is left " +
      "out with an `earnedUnavailableReason`, such as a live value that is unavailable, " +
      "movements that are still settling, or a withdrawal payout SDP did not observe; never " +
      "show it as zero. A wallet with no positions returns `positionCount: 0` and an empty " +
      "`totalsByToken`, not 404. Totals cover the positions the wallet holds now: a fully " +
      "withdrawn position drops out here but stays in the movements list. Live value reads " +
      "the wallet's whole balance in the strategy, so shares acquired outside SDP raise it.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletEarningsQuerySchema.extend({
        ownerAddress: earnOwnerAddressQueryParam,
      }),
    },
    responses: {
      200: {
        description: "Earnings per deposit token",
        content: jsonContent(earnExternalWalletEarningsResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/deposit-transactions",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Build a deposit transaction",
    operationId: "createEarnExternalWalletDepositTransaction",
    description:
      "Builds an unsigned deposit transaction for the customer's wallet to sign. Nothing " +
      "moves until you submit the signed transaction. The build applies provider access " +
      "checks and can name your own `feePayer`, which then signs alongside the customer. A " +
      "swap-funded deposit that cannot fit in one transaction returns a separate swap and " +
      "follow-up deposit instead of `transaction`, so check the response before you request " +
      "a signature.",
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
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/deposits",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Submit a deposit",
    operationId: "createEarnExternalWalletDeposit",
    description:
      "Submits a deposit transaction signed by the customer's wallet. SDP checks that the " +
      "signed bytes match the built transaction and that every required signature is valid " +
      "(the customer's, plus your fee payer's when the build named one), records the " +
      "movement, then broadcasts. Idempotency-Key is required: a retry with the same key " +
      "returns the original movement with `replayed: true`, and each built transaction can " +
      "be submitted once. Reusing a key with a different body, or submitting one build " +
      "under a second key, returns `409 CONFLICT`. Submit the original signed bytes even " +
      "after the blockhash " +
      "expires, since the transaction may already have landed. After an uncertain response, " +
      "retry with the same key and body, then read the movement instead of building a new " +
      "deposit.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(
          earnExternalWalletSubmitRequest.openapi({ example: EARN_DEPOSIT_SUBMIT_REQUEST_EXAMPLE })
        ),
      },
    },
    responses: {
      200: {
        description: "The recorded deposit",
        content: jsonContent(earnExternalWalletDepositResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-previews",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Preview a withdrawal",
    operationId: "createEarnExternalWalletWithdrawalPreview",
    description:
      "Quotes what withdrawing these shares would pay right now, from the strategy's live " +
      "accounting. When the strategy's `withdrawalSlippage` is not null, set `minAmountOut` " +
      "from this quote: take your tolerance off `assetsOut`, rounded down to " +
      "`assetDecimals`. The preview is read-only, takes no Idempotency-Key, and still works " +
      "after a strategy is deprecated or its provider stops taking deposits. It does not " +
      "check the wallet's balance, so keep `shares` within the position's " +
      "`withdrawableShares`. It returns 501 when the provider cannot quote withdrawals.",
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
        description: "Live withdrawal quote",
        content: jsonContent(earnExternalWalletWithdrawalPreviewResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-transactions",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Build a withdrawal transaction",
    operationId: "createEarnExternalWalletWithdrawalTransaction",
    description:
      "Builds an unsigned withdrawal transaction for a position, for the customer's wallet " +
      "to sign. Withdrawals keep working after a provider stops taking deposits. Send " +
      "`minAmountOut` when the strategy's `withdrawalSlippage` is not null, and omit it " +
      "when null. A provider-order route may not support a preview: it places an order that " +
      "pays out later, not an instant redemption.",
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
        description: "Unsigned withdrawal transaction",
        content: jsonContent(earnExternalWalletWithdrawalTransactionResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawals",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Submit a withdrawal",
    operationId: "createEarnExternalWalletWithdrawal",
    description:
      "Submits a withdrawal transaction signed by the customer's wallet. It works like a " +
      "deposit submit: SDP checks every signature against the exact built message, records " +
      "the movement before broadcast, requires an Idempotency-Key, and accepts each built " +
      "transaction once, with the same `409 CONFLICT` answers. Submit the original signed " +
      "bytes even after the blockhash expires, " +
      "since the transaction may already have landed. After an uncertain response, retry " +
      "with the same key and body, then read the movement instead of building a new " +
      "withdrawal.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(
          earnExternalWalletSubmitRequest.openapi({
            example: EARN_WITHDRAWAL_SUBMIT_REQUEST_EXAMPLE,
          })
        ),
      },
    },
    responses: {
      200: {
        description: "The recorded withdrawal",
        content: jsonContent(earnExternalWalletWithdrawalResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });

  registerEarnExternalWalletQueuedWithdrawalPaths(registry, security);
}

function registerEarnExternalWalletQueuedWithdrawalPaths(
  registry: OpenAPIRegistry,
  security: EarnSecurity
) {
  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-options",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "List withdrawal options",
    operationId: "getEarnExternalWalletWithdrawalOptions",
    description:
      "Lists the withdrawal routes a position supports right now: instant, provider order, " +
      "solver queue and operator redemption, each read from live provider state. A position " +
      "offers instant or provider order, never both; the withdrawal endpoints build " +
      "whichever it offers. Call this when the customer starts a withdrawal, and let them " +
      "choose when more than one route is available. Never infer a route from the " +
      "strategy's `liquidityTerm`.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletWithdrawalOptionsRequest),
      },
    },
    responses: {
      200: {
        description: "Withdrawal options and their live terms",
        content: jsonContent(earnExternalWalletWithdrawalOptionsResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/queued-withdrawal-previews",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Preview a withdrawal request",
    operationId: "createEarnExternalWalletQueuedWithdrawalPreview",
    description:
      "Previews a withdrawal request: a solver queue's discounted payout and timing, or an " +
      "operator redemption's intermediate-token conversion and payout. Check the mechanism " +
      "against the position's withdrawal options first, and resolve every `blockingIssues` " +
      "entry before the customer confirms. The preview is read-only and safe to retry. It " +
      "does not check the wallet's balance, so keep `shares` within the position's " +
      "`withdrawableShares`.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletQueuedWithdrawalPreviewRequest),
      },
    },
    responses: {
      200: {
        description: "Expected request terms",
        content: jsonContent(earnExternalWalletQueuedWithdrawalPreviewResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-request-transactions",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Build a withdrawal request transaction",
    operationId: "createEarnExternalWalletWithdrawalRequestTransaction",
    description:
      "Builds an unsigned withdrawal request transaction for a position, for the customer's " +
      "wallet to sign. A solver queue request escrows shares; an operator redemption " +
      "converts shares into an intermediate token that the operator settles later. Neither " +
      "transaction pays the customer. Save the `withdrawalRequestId` the submit returns and " +
      "track the request until it is fulfilled, canceled, or failed.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletWithdrawalRequestTransactionRequest),
      },
    },
    responses: {
      200: {
        description: "Unsigned withdrawal request transaction",
        content: jsonContent(earnExternalWalletWithdrawalRequestTransactionResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-requests",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Submit a withdrawal request",
    operationId: "createEarnExternalWalletWithdrawalRequest",
    description:
      "Submits a withdrawal request transaction signed by the customer's wallet. SDP checks " +
      "every signature against the exact built message, records the request before " +
      "broadcast, then sends it. Idempotency-Key is required: a retry with the same key " +
      "returns the original request, and each built transaction can be submitted once. " +
      "Reusing a key with a different body, or submitting one build under a second key, " +
      "returns `409 CONFLICT`.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(
          earnExternalWalletSubmitRequest.openapi({
            example: EARN_WITHDRAWAL_REQUEST_SUBMIT_REQUEST_EXAMPLE,
          })
        ),
      },
    },
    responses: {
      200: {
        description: "The recorded withdrawal request",
        content: jsonContent(earnExternalWalletWithdrawalRequestResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/withdrawal-requests",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "List withdrawal requests",
    operationId: "listEarnExternalWalletWithdrawalRequests",
    description:
      "Lists one customer wallet's withdrawal requests, one page at a time. `ownerAddress` " +
      "is required. On startup and after reconnecting, pass `settled=false` to restore " +
      "every request that still needs fulfillment, classification or cancellation, and page " +
      "until `hasMore` is false.",
    security,
    request: {
      headers: projectScopeHeaders,
      query: earnExternalWalletWithdrawalRequestsQuerySchema.extend({
        ownerAddress: earnOwnerAddressQueryParam,
        ...earnCursorQueryParams,
      }),
    },
    responses: {
      200: {
        description: "One page of withdrawal requests",
        content: jsonContent(earnExternalWalletWithdrawalRequestsResponse),
      },
      ...earnErrorResponses([400, 401, 403, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/earn/external-wallet/withdrawal-requests/{withdrawalRequestId}",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Get a withdrawal request",
    operationId: "getEarnExternalWalletWithdrawalRequest",
    description:
      "Gets one withdrawal request with its latest recorded status. Creating a request " +
      "escrows shares or converts them to an intermediate token; it does not pay out. Only " +
      "`fulfilled`, `cancelled` and `failed` are final. Keep polling a `closedOrUnknown` " +
      "request: SDP has not yet confirmed whether it paid out or returned the customer's " +
      "tokens.",
    security,
    request: {
      headers: projectScopeHeaders,
      params: earnVaultWithdrawalRequestParamsSchema.extend({
        withdrawalRequestId: earnWithdrawalRequestIdParam,
      }),
    },
    responses: {
      200: {
        description: "The withdrawal request",
        content: jsonContent(earnExternalWalletWithdrawalRequestResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 429, 500, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Build a cancellation transaction",
    operationId: "createEarnExternalWalletWithdrawalRequestCancelTransaction",
    description:
      "Builds an unsigned transaction that cancels a withdrawal request, for the customer's " +
      "wallet to sign. A solver queue request can be canceled only at `expiredCancelable`, " +
      "because a solver may fulfill it until its deadline; before then the build returns " +
      "`409 CONFLICT`. An operator redemption that allows cancellation can be canceled " +
      "while `pending`, which leaves the customer holding the intermediate token, not the " +
      "original shares.",
    security,
    request: {
      headers: projectScopeHeaders,
      body: {
        required: true,
        content: jsonContent(earnExternalWalletWithdrawalRequestCancelTransactionRequest),
      },
    },
    responses: {
      200: {
        description: "Unsigned cancellation transaction",
        content: jsonContent(earnExternalWalletWithdrawalRequestCancelTransactionResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 501, 503]),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/earn/external-wallet/withdrawal-request-cancellations",
    tags: ["Earn"],
    [DOCS_GROUP]: EARN_GROUPS.embeddedYield,
    summary: "Submit a cancellation",
    operationId: "createEarnExternalWalletWithdrawalRequestCancellation",
    description:
      "Submits a cancellation transaction signed by the customer's wallet. SDP verifies it, " +
      "records it before broadcast, and returns the withdrawal request. Idempotency-Key is " +
      "required, with the same `409 CONFLICT` answers as the other submits. Keep polling " +
      "until the request is `cancelled`, `fulfilled` or `failed`, " +
      "because a fulfillment can race the cancellation.",
    security,
    request: {
      headers: projectScopeWithRequiredIdempotencyHeaders,
      body: {
        required: true,
        content: jsonContent(
          earnExternalWalletSubmitRequest.openapi({ example: EARN_CANCEL_SUBMIT_REQUEST_EXAMPLE })
        ),
      },
    },
    responses: {
      200: {
        description: "The withdrawal request with its cancellation recorded",
        content: jsonContent(earnExternalWalletWithdrawalRequestCancellationResponse),
      },
      ...earnErrorResponses([400, 401, 403, 404, 409, 429, 500, 503]),
    },
  });
}
