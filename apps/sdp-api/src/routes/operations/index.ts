import { MOVEMENTS } from "@sdp/types/movements";
import { refreshOperationSchema, submitOperationSchema } from "@sdp/types/operations";
import { Hono } from "hono";
import type { OperationRecord, OperationScope } from "@/db/repositories/operations.repository";
import { getAuth } from "@/lib/auth";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { assertCallerWalletInScope, assertMoneyStartAdmitted } from "@/lib/money-admission";
import { success } from "@/lib/response";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { type AuthorizeInput, authorize, getAuthorized } from "@/middleware/authorize";
import { idempotent, markIdempotencyCommitted } from "@/middleware/idempotency";
import { enforceMeteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody, validateParams, validateQuery } from "@/middleware/validate";
import { type AppContext, requireEarnStrategyForCaller } from "@/routes/earn/context";
import {
  type AuthorizedEarnPreparation,
  authorizeEarnDeposit,
  authorizeEarnWithdrawal,
  earnOperationActor,
  prepareEarnStrategyAction,
} from "@/routes/earn/core/prepare";
import { assertRecordedStrategyDepositAdmitted } from "@/routes/earn/handlers/admission";
import { listReadableEarnWallets } from "@/routes/earn/wallet-scope";
import {
  isTerminalOperation,
  projectEarnOperation,
  submitEarnOperation,
} from "@/services/earn/strategy-operations.service";
import {
  assertReviewedOperationAction,
  createOperationsService,
} from "@/services/operations.service";
import type { Env } from "@/types/env";
import {
  emptyOperationBodySchema as emptyBody,
  operationIdParamsSchema as paramsSchema,
  operationsListQuerySchema as querySchema,
} from "./schemas";

interface AuthorizedOperation {
  record: OperationRecord;
  preparation: AuthorizedEarnPreparation | null;
}

async function loadAuthorizedOperation(
  c: AppContext,
  scope: OperationScope,
  spend: boolean
): Promise<OperationRecord> {
  const cached = c.get("operationRecord");
  if (cached !== undefined) return cached;
  const { operationId } = paramsSchema.parse(c.req.param());
  const record = await createOperationsService(c.env).repository.get(scope, operationId);
  if (record === null) throw notFound("Operation");
  const auth = getAuth(c);
  const walletId = "walletId" in record.source ? record.source.walletId : null;
  if (walletId !== null) {
    const wallets = await listReadableEarnWallets(c, auth, scope.projectId);
    if (!wallets.some((wallet) => wallet.id === walletId)) throw notFound("Operation");
    if (spend) assertCallerWalletInScope(auth, walletId);
  }
  c.set("operationRecord", record);
  return record;
}

async function authorizeOperation(c: AppContext, spend: boolean): Promise<AuthorizedOperation> {
  const record = await loadAuthorizedOperation(c, earnOperationActor(c), spend);
  return { record, preparation: null };
}

async function authorizeRefresh(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedOperation> {
  const authorized = await authorizeOperation(c, true);
  if (isTerminalOperation(authorized.record.operation)) return authorized;
  const { kind, ...body } = authorized.record.operation.intent;
  const prepareInput = { ...input, body };
  return {
    ...authorized,
    preparation:
      kind === "earn.deposit"
        ? await authorizeEarnDeposit(c, prepareInput)
        : await authorizeEarnWithdrawal(c, prepareInput),
  };
}

/** New exposure is admitted after replay; withdrawals retain their exit boundary. */
async function admitOperationStart(c: AppContext, record: OperationRecord): Promise<void> {
  if (MOVEMENTS[record.operation.kind].kind !== "start") return;
  await assertMoneyStartAdmitted(
    c.env,
    record.scope,
    { surface: "http", movement: record.operation.kind, subjectId: record.operation.id },
    { custodyWalletId: "walletId" in record.source ? record.source.walletId : null }
  );
}

const readOrCancelContext = projectContextMiddleware({ allowUnentitledProduction: () => true });
const movementContext = projectContextMiddleware({
  allowUnentitledProduction: async (c, scope) => {
    const record = await loadAuthorizedOperation(c, scope, true);
    return MOVEMENTS[record.operation.kind].kind === "exit";
  },
});

/** A shared URL retains each stored operation family's own money grants. */
export const operations = new Hono<{ Bindings: Env }>();
operations.use("*", unifiedAuthMiddleware());

operations.get(
  "/",
  readOrCancelContext,
  requireAction("earn.read"),
  validateQuery(querySchema),
  async (c) => {
    const actor = earnOperationActor(c);
    const query = querySchema.parse(c.req.query());
    const wallets = await listReadableEarnWallets(c, actor.auth, actor.projectId);
    if (query.walletId !== undefined && !wallets.some((wallet) => wallet.id === query.walletId))
      throw notFound("Wallet");
    const page = await createOperationsService(c.env).list(actor, {
      ...query,
      allowedWalletIds: wallets.map((wallet) => wallet.id),
    });
    return success(c, {
      ...page,
      operations: await Promise.all(
        page.operations.map((operation) => projectEarnOperation(c.env, actor, operation))
      ),
    });
  }
);

operations.get(
  "/:operationId",
  readOrCancelContext,
  requireAction("earn.read"),
  validateParams(paramsSchema),
  authorize((c) => authorizeOperation(c, false)),
  async (c) => {
    const { record } = getAuthorized<AuthorizedOperation>(c);
    return success(c, {
      operation: await projectEarnOperation(c.env, record.scope, record.operation),
    });
  }
);

operations.post(
  "/:operationId/submit",
  movementContext,
  requireAction("earn.execute"),
  validateParams(paramsSchema),
  validateBody(submitOperationSchema),
  authorize((c) => authorizeOperation(c, true)),
  idempotent({ key: "required", serverErrors: "rerun", committedServerErrors: "store" }),
  async (c) => {
    const { record } = getAuthorized<AuthorizedOperation>(c);
    const body = submitOperationSchema.parse(await c.req.json());
    await admitOperationStart(c, record);
    if (record.operation.intent.kind === "earn.deposit") {
      const { strategy } = await requireEarnStrategyForCaller(
        c,
        record.operation.intent.strategyId
      );
      await assertRecordedStrategyDepositAdmitted(c.env, record.scope, strategy);
    }
    return success(
      c,
      { operation: await submitEarnOperation(c.env, record.scope, record.operation.id, body, c) },
      202
    );
  }
);

operations.post(
  "/:operationId/refresh",
  movementContext,
  requireAction("earn.execute"),
  validateParams(paramsSchema),
  validateBody(refreshOperationSchema),
  authorize(authorizeRefresh),
  idempotent({ key: "required", serverErrors: "rerun", committedServerErrors: "store" }),
  async (c) => {
    const { record, preparation } = getAuthorized<AuthorizedOperation>(c);
    const body = refreshOperationSchema.parse(await c.req.json());
    assertReviewedOperationAction(record, body);
    const service = createOperationsService(c.env);
    await service.repository.requireRefreshablePreparation(record.scope, record.operation.id, body);
    const choosingOption = record.operation.nextAction?.type === "select_option";
    if (choosingOption && body.optionId === undefined)
      throw badRequest("Choose one of the advertised withdrawal options");
    if (
      body.optionId !== undefined &&
      (!choosingOption ||
        !record.operation.terms.options.some((option) => option.id === body.optionId))
    )
      throw badRequest("Operation option is not advertised for selection");
    if (isTerminalOperation(record.operation))
      return success(c, {
        operation: await projectEarnOperation(c.env, record.scope, record.operation),
      });
    if (preparation === null) throw badRequest("Operation has no refreshable action");
    await admitOperationStart(c, record);
    const attempt = await service.repository.getAttempt(record.scope, record.operation.id);
    if (
      "ownerAddress" in record.source &&
      record.operation.nextAction?.type === "sign_transaction" &&
      attempt?.signedTransaction == null
    ) {
      throw conflict("The exposed wallet transaction must be reconciled before refreshing", {
        reason: "wallet_transaction_outcome_unknown",
      });
    }
    const reference = attempt?.resourceRef;
    if (
      attempt !== null &&
      (attempt.signedTransaction !== null || attempt.dispatchStartedAt !== null) &&
      !(
        (reference?.kind === "custody.proposal" ||
          reference?.kind === "custody.proposal_not_sent") &&
        record.operation.error !== null
      )
    ) {
      throw conflict("The current transaction must be reconciled before refreshing");
    }
    if (MOVEMENTS[record.operation.kind].kind === "start") {
      await enforceMeteredQuota(c, { name: "earn-provider-read", actorMax: 60, orgMax: 240 });
    }
    const prepared = await prepareEarnStrategyAction(
      c,
      preparation,
      body.optionId ??
        (record.operation.intent.kind === "earn.withdraw"
          ? record.operation.terms.options[0]?.id
          : undefined)
    );
    const evidence =
      reference?.kind === "custody.proposal" || reference?.kind === "custody.proposal_not_sent"
        ? { kind: "resolved_attempt" as const, resourceRef: reference }
        : { kind: "never_dispatched" as const };
    const operation = await service.repository.replacePreparedAction(
      record.scope,
      record.operation.id,
      record.operation,
      prepared,
      evidence
    );
    markIdempotencyCommitted(c);
    return success(c, { operation }, 202);
  }
);

operations.post(
  "/:operationId/cancel",
  readOrCancelContext,
  requireAction("earn.manage"),
  validateParams(paramsSchema),
  validateBody(emptyBody),
  authorize((c) => authorizeOperation(c, true)),
  idempotent({ key: "required", serverErrors: "rerun", committedServerErrors: "store" }),
  async (c) => {
    const { record } = getAuthorized<AuthorizedOperation>(c);
    const service = createOperationsService(c.env);
    const operation = await service.cancelPreparation(record.scope, record.operation.id);
    markIdempotencyCommitted(c);
    return success(c, { operation });
  }
);
