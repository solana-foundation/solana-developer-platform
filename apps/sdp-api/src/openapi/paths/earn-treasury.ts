import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { earnBalanceReadContextSchema } from "@sdp/types/earn-wire";
import * as requests from "@/routes/earn/schemas";
import { errorResponseSchema, successResponseSchema, z } from "../schemas/base";
import {
  earnExternalWalletWithdrawalRequestResponse,
  earnExternalWalletWithdrawalRequestsResponse,
} from "../schemas/earn";
import * as responses from "../schemas/earn-treasury";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithIdempotencyHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

const dryRun = responses.envelope({
  decision: z.enum([
    "allow",
    "deny",
    "approval_required",
    "provider_approval_required",
    "review",
    "not_evaluated",
  ]),
  reason: z.string(),
  criteria: z.array(
    z.object({
      scope: z.enum(["wallet", "api_key"]),
      ruleId: z.string().nullable(),
      kind: z.string(),
      name: z.string().nullable(),
      matched: z.boolean(),
      action: z
        .enum([
          "allow",
          "deny",
          "approval_required",
          "provider_approval_required",
          "review",
          "not_evaluated",
        ])
        .nullable(),
      reason: z.string().nullable(),
      leg: z.number().int().nullable(),
    })
  ),
  walletPolicyRevisionId: z.string().nullable(),
  apiKeyPolicyRevisionId: z.string().nullable(),
});

/** Internal Treasury contracts. Public Earn publication is gated separately. */
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
      idempotency?: "required" | "either";
      policy?: boolean;
      created?: boolean;
      description?: string;
    } = {}
  ) {
    const headers =
      options.idempotency === "required"
        ? projectScopeWithRequiredIdempotencyHeaders
        : options.idempotency === "either"
          ? projectScopeWithIdempotencyHeaders
          : projectScopeHeaders;
    registry.registerPath({
      method,
      path: `/v1/earn/${path}`,
      operationId,
      summary,
      tags: ["Earn"],
      security,
      description:
        (options.description ??
          `Tenant-scoped Treasury operation. Requires earn:${method === "get" || path.endsWith("preview") || path.includes("previews") || path.endsWith("options") ? "read" : "write"}.`) +
        (options.idempotency
          ? " A new intentional operation needs a new Idempotency-Key, even with identical terms. Retrying an uncertain operation must reuse its key and exact payload."
          : "") +
        (options.idempotency === "either"
          ? " Supply exactly one UUIDv4 key, through Idempotency-Key or body requestId."
          : "") +
        (options.policy
          ? " Dry-Run: true evaluates policy without signing or writing intent. HTTP 202 means approval is pending, not that funds moved."
          : ""),
      request: {
        headers: options.policy
          ? headers.extend({ "Dry-Run": z.literal("true").optional() })
          : headers,
        ...(options.params ? { params: options.params } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.body ? { body: { required: true, content: jsonContent(options.body) } } : {}),
      },
      responses: {
        200: {
          description: options.policy
            ? "Recorded outcome, replay, or policy dry-run result"
            : "Result",
          content: jsonContent(options.policy ? z.union([response, dryRun]) : response),
        },
        ...(options.created
          ? { 201: { description: "Created", content: jsonContent(response) } }
          : {}),
        ...(options.policy
          ? {
              202: {
                description: "Awaiting policy approval; no new transfer is confirmed",
                content: jsonContent(errorResponseSchema),
              },
            }
          : {}),
        ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 429, 500, 501, 503]),
      },
    });
  }
  const { envelope, pageFields, listFields } = responses;
  const deposit = successResponseSchema(responses.earnVaultDepositSchema);
  const depositRecord = envelope({ deposit: responses.earnVaultDepositRecordSchema });
  const withdrawal = envelope({ withdrawal: responses.earnVaultWithdrawalSchema });
  const program = envelope({ program: responses.earnProgramSchema });
  const programWithdrawal = envelope({ withdrawal: responses.earnPortfolioWithdrawalSchema });
  route(
    "get",
    "movements",
    "listEarnMovements",
    "List all scoped Earn movements",
    envelope({ movements: z.array(responses.earnMovementSchema), ...pageFields }),
    { query: requests.earnMovementsQuerySchema }
  );
  route(
    "post",
    "vault-deposits",
    "createEarnVaultDeposit",
    "Deposit from a custody wallet",
    deposit,
    {
      body: requests.earnVaultDepositSchema
        .omit({ requestId: true })
        .openapi({ not: { required: ["requestId"] } }),
      idempotency: "required",
      policy: true,
    }
  );
  route(
    "get",
    "vault-deposits",
    "listEarnVaultDeposits",
    "List custody deposits",
    envelope({ deposits: z.array(responses.earnVaultDepositRecordSchema), ...pageFields }),
    { query: requests.earnVaultDepositsQuerySchema }
  );
  route(
    "get",
    "vault-deposits/{movementId}",
    "getEarnVaultDeposit",
    "Read one custody deposit",
    depositRecord,
    { params: requests.earnVaultDepositParamsSchema }
  );
  route(
    "get",
    "vault-positions",
    "listEarnVaultPositions",
    "List live custody positions",
    envelope({
      positions: z.array(responses.earnVaultPositionSchema),
      balanceReadContext: earnBalanceReadContextSchema.optional(),
      ...pageFields,
    }),
    {
      query: requests.earnVaultPositionsQuerySchema,
      description:
        "Requires earn:read. Optional afterMovementIds is a comma-separated list of up to 100 visible custody movement IDs. Balance reads must observe chain context at or after every movement's confirmed slot. balanceReadContext acknowledges that bound; unavailable or stale provider values remain absent. confirmed is optimistic chain commitment; finalized or provider settlement supplies final amounts.",
    }
  );
  route(
    "post",
    "vault-withdrawals",
    "createEarnVaultWithdrawal",
    "Withdraw from a custody position",
    withdrawal,
    {
      body: requests.earnVaultWithdrawalSchema
        .omit({ requestId: true })
        .openapi({ not: { required: ["requestId"] } }),
      idempotency: "required",
      policy: true,
    }
  );
  route(
    "get",
    "vault-withdrawals",
    "listEarnVaultWithdrawals",
    "List custody withdrawals",
    envelope({ withdrawals: z.array(responses.earnVaultWithdrawalSchema), ...pageFields }),
    { query: requests.earnVaultWithdrawalsQuerySchema }
  );
  route(
    "get",
    "vault-withdrawals/{movementId}",
    "getEarnVaultWithdrawal",
    "Read one custody withdrawal",
    withdrawal,
    { params: requests.earnVaultWithdrawalParamsSchema }
  );
  route(
    "post",
    "vault-withdrawal-previews",
    "createEarnVaultWithdrawalPreview",
    "Preview a custody withdrawal",
    responses.earnVaultWithdrawalPreviewResponse,
    { body: requests.earnVaultWithdrawalPreviewSchema }
  );
  route(
    "post",
    "vault-withdrawal-options",
    "getEarnVaultWithdrawalOptions",
    "Discover custody withdrawal routes",
    responses.earnVaultWithdrawalOptionsResponse,
    { body: requests.earnVaultWithdrawalOptionsSchema }
  );
  route(
    "post",
    "vault-queued-withdrawal-previews",
    "createEarnVaultQueuedWithdrawalPreview",
    "Preview a queued custody withdrawal",
    responses.earnVaultQueuedWithdrawalPreviewResponse,
    { body: requests.earnVaultQueuedWithdrawalPreviewSchema }
  );
  route(
    "post",
    "vault-withdrawal-requests",
    "createEarnVaultWithdrawalRequest",
    "Request a queued custody withdrawal",
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
      policy: true,
    }
  );
  route(
    "get",
    "vault-withdrawal-requests",
    "listEarnVaultWithdrawalRequests",
    "List custody withdrawal requests",
    earnExternalWalletWithdrawalRequestsResponse,
    { query: requests.earnVaultWithdrawalRequestsQuerySchema }
  );
  route(
    "get",
    "vault-withdrawal-requests/{withdrawalRequestId}",
    "getEarnVaultWithdrawalRequest",
    "Read a custody withdrawal request",
    earnExternalWalletWithdrawalRequestResponse,
    { params: requests.earnVaultWithdrawalRequestParamsSchema }
  );
  route(
    "post",
    "vault-withdrawal-requests/{withdrawalRequestId}/cancel",
    "cancelEarnVaultWithdrawalRequest",
    "Recover a cancelable withdrawal request",
    earnExternalWalletWithdrawalRequestResponse,
    {
      params: requests.earnVaultWithdrawalRequestParamsSchema,
      body: requests.earnVaultWithdrawalRequestCancelSchema.omit({ requestId: true }),
      idempotency: "required",
    }
  );
  route(
    "get",
    "programs",
    "listEarnPrograms",
    "List provider-managed programs",
    envelope({ programs: z.array(responses.earnProgramSchema), ...listFields }),
    { query: requests.earnProgramsListQuerySchema }
  );
  route("post", "programs", "createEarnProgram", "Create a provider-managed program", program, {
    body: requests.earnProgramCreateSchema,
    idempotency: "either",
    created: true,
  });
  route(
    "get",
    "programs/{programId}",
    "getEarnProgram",
    "Read a provider-managed program",
    program,
    { params: requests.earnProgramParamsSchema }
  );
  route(
    "put",
    "programs/{programId}",
    "retargetEarnProgram",
    "Change a program's allocation",
    program,
    { params: requests.earnProgramParamsSchema, body: requests.earnProgramRetargetSchema }
  );
  route(
    "get",
    "programs/{programId}/deposits",
    "listEarnProgramDeposits",
    "List program deposits",
    envelope({
      deposits: z.array(responses.earnPortfolioDepositSchema),
      nextCursor: z.string().nullable(),
    }),
    { params: requests.earnProgramParamsSchema, query: requests.earnProgramDepositsQuerySchema }
  );
  route(
    "post",
    "programs/{programId}/withdrawal-preview",
    "previewEarnProgramWithdrawal",
    "Preview a program withdrawal or read liquidity",
    envelope({ preview: responses.earnProgramWithdrawalPreviewSchema }),
    { params: requests.earnProgramParamsSchema, body: requests.earnProgramWithdrawalPreviewSchema }
  );
  route(
    "post",
    "programs/{programId}/withdrawals",
    "createEarnProgramWithdrawal",
    "Withdraw from a provider-managed program",
    programWithdrawal,
    {
      params: requests.earnProgramParamsSchema,
      body: requests.earnProgramWithdrawalCreateSchema,
      idempotency: "either",
      policy: true,
      created: true,
    }
  );
  route(
    "get",
    "programs/{programId}/withdrawals",
    "listEarnProgramWithdrawals",
    "List recorded program withdrawals",
    envelope({ withdrawals: z.array(responses.earnProgramWithdrawalRecordSchema), ...listFields }),
    {
      params: requests.earnProgramParamsSchema,
      query: requests.earnProgramWithdrawalsListQuerySchema,
    }
  );
  route(
    "get",
    "programs/{programId}/withdrawals/{withdrawalRef}",
    "getEarnProgramWithdrawal",
    "Read a program withdrawal",
    programWithdrawal,
    { params: requests.earnProgramWithdrawalParamsSchema }
  );
}
