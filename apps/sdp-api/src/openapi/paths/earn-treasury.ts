import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import {
  earnBalanceReadContextSchema,
  earnVaultDepositRecordSchema,
  earnVaultDepositSchema,
  earnVaultWithdrawalSchema,
} from "@sdp/types/earn-wire";
import { z } from "zod";
import { successResponseSchema } from "@/openapi/schemas/base";
import {
  earnExternalWalletWithdrawalRequestResponse,
  earnExternalWalletWithdrawalRequestsResponse,
} from "@/openapi/schemas/earn";
import {
  earnMovementSchema,
  earnPortfolioDepositSchema,
  earnPortfolioWithdrawalSchema,
  earnProgramSchema,
  earnProgramWithdrawalPreviewSchema,
  earnProgramWithdrawalRecordSchema,
  earnVaultPositionSchema,
  earnVaultQueuedWithdrawalPreviewResponse,
  earnVaultWithdrawalOptionsResponse,
  earnVaultWithdrawalPreviewResponse,
  envelope,
  listFields,
  pageFields,
} from "@/openapi/schemas/earn-treasury";
import * as requests from "@/routes/earn/schemas";
import { earnErrorResponses } from "./earn-errors";
import { EARN_GROUPS } from "./earn-groups";
import {
  DOCS_GROUP,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithIdempotencyHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

type TreasuryIdempotency = "required" | "either" | "optional-either";

function idempotencyContract(idempotency: TreasuryIdempotency | undefined) {
  const retryAdvice =
    " A new intentional operation needs a new Idempotency-Key, even with identical terms. Retrying an uncertain operation must reuse its key and exact payload.";
  switch (idempotency) {
    case undefined:
      return { headers: projectScopeHeaders, description: "" };
    case "required":
      return { headers: projectScopeWithRequiredIdempotencyHeaders, description: retryAdvice };
    case "either":
      return {
        headers: projectScopeWithIdempotencyHeaders,
        description:
          retryAdvice +
          " Supply exactly one key through Idempotency-Key or body requestId (UUIDv4).",
      };
    case "optional-either":
      return {
        headers: projectScopeWithIdempotencyHeaders,
        description:
          retryAdvice +
          " An idempotency key is optional; send Idempotency-Key or body requestId (UUIDv4), never both.",
      };
    default: {
      const exhaustive: never = idempotency;
      throw new Error(`Unknown Treasury idempotency mode: ${exhaustive}`);
    }
  }
}

/** Internal Treasury contracts, excluded from the public Earn registration. */
export function registerEarnTreasuryPaths(
  registry: OpenAPIRegistry,
  security: Array<Record<string, string[]>>
) {
  type Query = NonNullable<
    NonNullable<Parameters<OpenAPIRegistry["registerPath"]>[0]["request"]>["query"]
  >;
  function route(
    method: "get" | "post" | "put",
    path: string,
    operationId: string,
    summary: string,
    response: z.ZodType,
    options: {
      body?: z.ZodType;
      query?: Query;
      params?: Query;
      idempotency?: TreasuryIdempotency;
      signs?: true;
      created?: boolean;
      description: string;
    }
  ) {
    const idempotency = idempotencyContract(options.idempotency);
    registry.registerPath({
      method,
      path: `/v1/earn/${path}`,
      operationId,
      summary,
      tags: ["Earn"],
      [DOCS_GROUP]: path.startsWith("portfolio-accounts")
        ? EARN_GROUPS.programs
        : EARN_GROUPS.treasury,
      security,
      description: options.description + idempotency.description,
      request: {
        headers: idempotency.headers,
        ...(options.params ? { params: options.params } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.body ? { body: { required: true, content: jsonContent(options.body) } } : {}),
      },
      responses: {
        200: { description: "Result", content: jsonContent(response) },
        ...(options.created
          ? { 201: { description: "Created", content: jsonContent(response) } }
          : {}),
        ...earnErrorResponses(
          options.signs
            ? [400, 401, 403, 404, 409, 422, 429, 500, 501, 503]
            : [400, 401, 403, 404, 409, 429, 500, 501, 503]
        ),
      },
    });
  }
  const deposit = successResponseSchema(earnVaultDepositSchema);
  const depositRecord = envelope({ deposit: earnVaultDepositRecordSchema });
  const withdrawal = envelope({ withdrawal: earnVaultWithdrawalSchema });
  const program = envelope({ program: earnProgramSchema });
  const programWithdrawal = envelope({ withdrawal: earnPortfolioWithdrawalSchema });
  route(
    "get",
    "treasury/movements",
    "listEarnMovements",
    "List all movements",
    envelope({ movements: z.array(earnMovementSchema), ...pageFields }),
    {
      query: requests.earnMovementsQuerySchema,
      description:
        "Lists recorded custody-wallet and provider-program movements, newest " +
        "first, one page at a time. Amounts use each row's denomination, so " +
        "never sum different tokens or mix them with USD. Customer-wallet " +
        "movements have their own per-wallet endpoint. History stays available " +
        "after a provider is disabled.",
    }
  );
  route(
    "post",
    "deposits/execute",
    "createEarnVaultDeposit",
    "Deposit from a connected wallet",
    deposit,
    {
      body: requests.earnVaultDepositSchema
        .omit({ requestId: true })
        .openapi({ not: { required: ["requestId"] } }),
      idempotency: "required",
      signs: true,
      description:
        "Builds, signs and broadcasts a deposit from an authorized custody wallet. Quote " +
        "first when the strategy requires minSharesOut. Swap-funded deposits stay atomic; " +
        "if the combined transaction cannot fit, the request is refused without sending. " +
        "Convert funds separately or deposit the vault's own token before retrying.",
    }
  );
  route(
    "get",
    "deposits/provider-signed",
    "listEarnVaultDeposits",
    "List wallet deposits",
    envelope({ deposits: z.array(earnVaultDepositRecordSchema), ...pageFields }),
    {
      query: requests.earnVaultDepositsQuerySchema,
      description:
        "Returns recorded custody deposits, newest first, within the project and wallet " +
        "scope. Filter by requestId using the original Idempotency-Key to recover a deposit " +
        "whose response was lost. Use settled=false to restore deposits still being tracked.",
    }
  );
  route(
    "get",
    "deposits/provider-signed/{movementId}",
    "getEarnVaultDeposit",
    "Read one wallet deposit",
    depositRecord,
    {
      params: requests.earnVaultDepositParamsSchema,
      description:
        "Returns one recorded custody deposit and refreshes its chain observation when " +
        "available. This response uses legacy status names: pending means recorded, and " +
        "confirmed covers both chain confirmation and finality. For provider-order deposits, " +
        "confirmed does not prove receipt of shares; settled=false remains the recovery read.",
    }
  );
  route(
    "get",
    "positions/provider-signed",
    "listEarnVaultPositions",
    "List live wallet positions",
    envelope({
      positions: z.array(earnVaultPositionSchema),
      balanceReadContext: earnBalanceReadContextSchema.optional(),
      ...pageFields,
    }),
    {
      query: requests.earnVaultPositionsQuerySchema,
      description:
        "Returns live balances for the project's authorized custody positions. Optional " +
        "afterMovementIds accepts up to 100 comma-separated movement IDs and requires each " +
        "affected balance to be read at or after its latest confirmed slot. The returned " +
        "balanceReadContext acknowledges that bound. Unavailable or stale live values stay " +
        "absent; do not display them as zero.",
    }
  );
  route(
    "post",
    "withdrawals/execute",
    "createEarnVaultWithdrawal",
    "Withdraw from a wallet position",
    withdrawal,
    {
      body: requests.earnVaultWithdrawalSchema
        .omit({ requestId: true })
        .openapi({ not: { required: ["requestId"] } }),
      idempotency: "required",
      signs: true,
      description:
        "Redeems a position's shares into the custody wallet that owns them. Call " +
        "vault-withdrawal-options first to select a supported route, then quote the direct " +
        "exit when minAmountOut is required. A strategy disabled for new deposits remains " +
        "exitable. Provider-order exits finish only when the provider completes the payout.",
    }
  );
  route(
    "get",
    "withdrawals/provider-signed",
    "listEarnVaultWithdrawals",
    "List wallet withdrawals",
    envelope({ withdrawals: z.array(earnVaultWithdrawalSchema), ...pageFields }),
    {
      query: requests.earnVaultWithdrawalsQuerySchema,
      description:
        "Returns recorded custody withdrawals, newest first, within the project and wallet " +
        "scope. Filter by requestId using the original Idempotency-Key after a lost response. " +
        "Use settled=false to restore withdrawals still being tracked.",
    }
  );
  route(
    "get",
    "withdrawals/provider-signed/{movementId}",
    "getEarnVaultWithdrawal",
    "Read one wallet withdrawal",
    withdrawal,
    {
      params: requests.earnVaultWithdrawalParamsSchema,
      description:
        "Gets one recorded custody withdrawal and refreshes its onchain status " +
        "when it can. An atomic withdrawal can show as done at `confirmed`; a " +
        "provider-order withdrawal stays pending until the provider completes " +
        "it. `shares` is the requested share quantity, not the payout; the " +
        "movements feed reports `tokenAmount` once SDP observes a finalized " +
        "payout.",
    }
  );
  route(
    "post",
    "withdrawals/provider-signed/preview",
    "createEarnVaultWithdrawalPreview",
    "Preview a wallet withdrawal",
    earnVaultWithdrawalPreviewResponse,
    {
      body: requests.earnVaultWithdrawalPreviewSchema,
      description:
        "Quotes the live deposit-token payout for a custody position's shares. Derive " +
        "minAmountOut from assetsOut minus your chosen tolerance, quantized to assetDecimals. " +
        "Read-only and safe to retry. Providers without exit quoting return 501; a " +
        "provider-order route with no slippage policy does not require this preview.",
    }
  );
  route(
    "post",
    "withdrawals/provider-signed/options",
    "getEarnVaultWithdrawalOptions",
    "Discover wallet withdrawal routes",
    earnVaultWithdrawalOptionsResponse,
    {
      body: requests.earnVaultWithdrawalOptionsSchema,
      description:
        "Discovers atomic, provider-order, solver-queue and operator-redemption routes from " +
        "live provider state. Call when starting a withdrawal and let the customer choose " +
        "when several routes are available. Do not infer availability from liquidityTerm.",
    }
  );
  route(
    "post",
    "withdrawal-requests/provider-signed/preview",
    "createEarnVaultQueuedWithdrawalPreview",
    "Preview a queued wallet withdrawal",
    earnVaultQueuedWithdrawalPreviewResponse,
    {
      body: requests.earnVaultQueuedWithdrawalPreviewSchema,
      description:
        "Quotes the selected solver queue's payout and timing, or an operator redemption's " +
        "intermediate-token conversion and expected par payout. Read the live withdrawal " +
        "options first and resolve blockingIssues before confirming. Nothing moves.",
    }
  );
  route(
    "post",
    "withdrawal-requests/execute",
    "createEarnVaultWithdrawalRequest",
    "Request a queued wallet withdrawal",
    earnExternalWalletWithdrawalRequestResponse,
    {
      body: z
        .union(
          requests.earnVaultWithdrawalRequestSchema.options.map((option) => {
            const { requestId: _requestId, ...shape } = option.shape;
            return z.strictObject(shape);
          })
        )
        .openapi({ not: { required: ["requestId"] } }),
      idempotency: "required",
      signs: true,
      description:
        "Signs and submits a durable asynchronous withdrawal request. Solver queues escrow " +
        "shares; operator redemptions convert shares into delegated intermediate tokens, or " +
        "delegate intermediate tokens already held. The request transaction is not a payout. " +
        "Track withdrawalRequestId until fulfilled, cancelled or failed.",
    }
  );
  route(
    "get",
    "withdrawal-requests/provider-signed",
    "listEarnVaultWithdrawalRequests",
    "List wallet withdrawal requests",
    earnExternalWalletWithdrawalRequestsResponse,
    {
      query: requests.earnVaultWithdrawalRequestsQuerySchema,
      description:
        "Lists withdrawal requests for the custody positions your key can " +
        "access, one page at a time. Restore open requests with `settled=false` " +
        "and page until `hasMore` is false. A `closedOrUnknown` request stays " +
        "open until provider evidence resolves it.",
    }
  );
  route(
    "get",
    "withdrawal-requests/provider-signed/{withdrawalRequestId}",
    "getEarnVaultWithdrawalRequest",
    "Read a wallet withdrawal request",
    earnExternalWalletWithdrawalRequestResponse,
    {
      params: requests.earnVaultWithdrawalRequestParamsSchema,
      description:
        "Returns the last durable lifecycle observation for an asynchronous custody exit. " +
        "Only fulfilled, cancelled and failed are terminal. A finalized request transaction " +
        "does not prove payout; keep polling closedOrUnknown until the outcome is known.",
    }
  );
  route(
    "post",
    "withdrawal-requests/{withdrawalRequestId}/cancel/execute",
    "cancelEarnVaultWithdrawalRequest",
    "Cancel a custody withdrawal request",
    earnExternalWalletWithdrawalRequestResponse,
    {
      params: requests.earnVaultWithdrawalRequestParamsSchema,
      body: requests.earnVaultWithdrawalRequestCancelSchema.omit({ requestId: true }),
      idempotency: "required",
      signs: true,
      description:
        "Signs and submits a cancellation for a cancelable custody withdrawal request. Requires " +
        "`earn.manage` and write access to the custody wallet. A solver queue request returns " +
        "its escrowed shares only after the deadline; an operator redemption returns its " +
        "delegated intermediate tokens, not the original shares. Cancellation stays available " +
        "without production access and while Earn is disabled; a suspended organization still " +
        "cannot authenticate. A fulfillment can race the cancellation, so track the returned " +
        "request.",
    }
  );
  route(
    "get",
    "portfolio-accounts",
    "listEarnPrograms",
    "List provider portfolio accounts",
    envelope({ programs: z.array(earnProgramSchema), ...listFields }),
    {
      query: requests.earnProgramsListQuerySchema,
      description:
        "Lists the project's linked provider programs with live wallet balances and yield. " +
        "A failed provider read fails the whole page; programs holding funds are never " +
        "silently dropped. Use the provider filter to isolate one provider.",
    }
  );
  route(
    "post",
    "portfolio-accounts",
    "createEarnProgram",
    "Create a provider portfolio account",
    program,
    {
      body: requests.earnProgramCreateSchema,
      idempotency: "either",
      created: true,
      description:
        "Creates and links a provider-managed wallet for the project, without funding it. " +
        "Fund wallet.solanaDepositAddress separately after creation. Each supplied token group " +
        "currently requires one allocation at 100 percent. Returns 201 for a new program and " +
        "200 for an idempotent replay.",
    }
  );
  route(
    "get",
    "portfolio-accounts/{programId}",
    "getEarnProgram",
    "Read a provider portfolio account",
    program,
    {
      params: requests.earnProgramParamsSchema,
      description:
        "Reads a linked program's balances, allocations and yield directly from its " +
        "provider. The program remains readable when new deposits are disabled, provided " +
        "the provider capability and credentials remain available.",
    }
  );
  route(
    "put",
    "portfolio-accounts/{programId}/allocation",
    "retargetEarnProgram",
    "Change a portfolio account's allocation",
    program,
    {
      params: requests.earnProgramParamsSchema,
      body: requests.earnProgramRetargetSchema,
      idempotency: "optional-either",
      description:
        "Updates the provider program's allocation in place and returns fresh live state. " +
        "Each supplied token group currently requires one allocation at 100 percent; " +
        "omitted token groups keep their existing allocation. The program label is unchanged.",
    }
  );
  route(
    "get",
    "portfolio-accounts/{programId}/deposits",
    "listEarnProgramDeposits",
    "List portfolio-account deposits",
    envelope({
      deposits: z.array(earnPortfolioDepositSchema),
      nextCursor: z.string().nullable(),
    }),
    {
      params: requests.earnProgramParamsSchema,
      query: requests.earnProgramDepositsQuerySchema,
      description:
        "Reads deposit history directly from the program's provider. Pass its nextCursor " +
        "back as cursor to continue; null means there are no more deposits.",
    }
  );
  route(
    "post",
    "portfolio-accounts/{programId}/withdrawals/preview",
    "previewEarnProgramWithdrawal",
    "Preview a portfolio-account withdrawal or read liquidity",
    envelope({ preview: earnProgramWithdrawalPreviewSchema }),
    {
      params: requests.earnProgramParamsSchema,
      body: requests.earnProgramWithdrawalPreviewSchema,
      description:
        "Reads live withdrawal liquidity and fees without moving funds. Omit amountUsd " +
        "to read liquidity only, or include it to preview a payout. Wallet-scoped API keys " +
        "cannot use this provider account; use an organization-wide key.",
    }
  );
  route(
    "post",
    "portfolio-accounts/{programId}/withdrawals/execute",
    "createEarnProgramWithdrawal",
    "Withdraw from a provider portfolio account",
    programWithdrawal,
    {
      params: requests.earnProgramParamsSchema,
      body: requests.earnProgramWithdrawalCreateSchema,
      idempotency: "either",
      created: true,
      description:
        "Requests a provider-managed payout to destinationAddress and records the intent " +
        "before calling the provider. Wallet-scoped API keys are refused. Returns 201 for " +
        "an accepted request and 200 for a matching replay; reuse the original key and " +
        "payload after an uncertain response. Track the live provider withdrawal outcome.",
    }
  );
  route(
    "get",
    "portfolio-accounts/{programId}/withdrawals",
    "listEarnProgramWithdrawals",
    "List recorded portfolio-account withdrawals",
    envelope({ withdrawals: z.array(earnProgramWithdrawalRecordSchema), ...listFields }),
    {
      params: requests.earnProgramParamsSchema,
      query: requests.earnProgramWithdrawalsListQuerySchema,
      description:
        "Lists the program's recorded payout intents from SDP, including requests awaiting " +
        "provider acceptance. This audit history remains available if provider credentials " +
        "are removed. Use withdrawalRef with the detail endpoint for live provider state.",
    }
  );
  route(
    "get",
    "portfolio-accounts/{programId}/withdrawals/{withdrawalRef}",
    "getEarnProgramWithdrawal",
    "Read a portfolio-account withdrawal",
    programWithdrawal,
    {
      params: requests.earnProgramWithdrawalParamsSchema,
      description:
        "Reads one payout's current state directly from the provider and refreshes its " +
        "recorded observation. Use the withdrawalRef returned after provider acceptance. " +
        "A partially_completed result reports a partial payout; it is not full payment.",
    }
  );
}
