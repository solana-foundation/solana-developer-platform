import { executeOperationSchema } from "@sdp/types/operations";
import { Hono } from "hono";
import type { OperationRecord } from "@/db/repositories/operations.repository";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import { success } from "@/lib/response";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { type AuthorizeInput, authorize, getAuthorized } from "@/middleware/authorize";
import { idempotent, markIdempotencyCommitted } from "@/middleware/idempotency";
import { projectContextMiddleware } from "@/middleware/project-context";
import { assertCallerMayPerform, requireAction } from "@/middleware/require-action";
import { validateBody, validateParams, validateQuery } from "@/middleware/validate";
import type { AppContext } from "@/routes/earn/context";
import {
  type AuthorizedEarnOperationCancellation,
  authorizeEarnOperationCancellation,
  prepareEarnOperationCancellation,
} from "@/routes/earn/core/cancellation";
import { authorizeEarnDepositRefresh } from "@/routes/earn/core/deposit-refresh";
import {
  type AuthorizedEarnPreparation,
  authorizeEarnDeposit,
  authorizeEarnWithdrawal,
  earnOperationActor,
  prepareEarnStrategyAction,
} from "@/routes/earn/core/prepare";
import { listReadableEarnWallets } from "@/routes/earn/wallet-scope";
import {
  executeEarnOperation,
  isTerminalOperation,
  projectEarnOperation,
} from "@/services/earn/strategy-operations.service";
import {
  requirePreparedSwapStrategyTransaction,
  swapStrategyContinuation,
} from "@/services/earn/strategy-swap-operations.service";
import { createOperationsService } from "@/services/operations.service";
import type { Env } from "@/types/env";
import {
  emptyOperationBodySchema as emptyBody,
  operationIdParamsSchema as paramsSchema,
  operationsListQuerySchema as querySchema,
} from "./schemas";

interface AuthorizedOperation {
  record: OperationRecord;
  preparation: AuthorizedEarnPreparation | null;
  cancellation?: AuthorizedEarnOperationCancellation | null;
}

async function authorizeOperation(
  c: AppContext,
  input: AuthorizeInput,
  spend: boolean
): Promise<AuthorizedOperation> {
  const { operationId } = paramsSchema.parse(input.params);
  const actor = earnOperationActor(c);
  const record = await createOperationsService(c.env).repository.get(actor, operationId);
  if (record === null) throw notFound("Operation");
  const walletId = "walletId" in record.source ? record.source.walletId : null;
  if (walletId !== null) {
    const wallets = await listReadableEarnWallets(c, actor.auth, actor.projectId);
    if (!wallets.some((wallet) => wallet.id === walletId)) throw notFound("Operation");
    if (spend) assertCallerWalletInScope(actor.auth, walletId);
  }
  return { record, preparation: null };
}

async function authorizeRefresh(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedOperation> {
  const authorized = await authorizeOperation(c, input, true);
  if (isTerminalOperation(authorized.record.operation)) return authorized;
  if (authorized.record.actionPurpose === "cancel") {
    assertCallerMayPerform(c, "earn.manage");
    return {
      ...authorized,
      cancellation: await authorizeEarnOperationCancellation(c, authorized.record, {
        includePrepared: true,
      }),
    };
  }
  const { kind, ...body } = authorized.record.operation.intent;
  const prepareInput = { ...input, body };
  return {
    ...authorized,
    preparation:
      kind === "earn.deposit"
        ? await authorizeEarnDepositRefresh(
            c,
            authorized.record,
            await authorizeEarnDeposit(c, prepareInput)
          )
        : await authorizeEarnWithdrawal(c, prepareInput),
  };
}

async function authorizeExecution(
  c: AppContext,
  input: AuthorizeInput
): Promise<AuthorizedOperation> {
  const authorized = await authorizeOperation(c, input, true);
  return authorized.record.operation.buildRef?.kind === "earn.withdrawal_options" ||
    authorized.record.operation.buildRef?.kind === "earn.deposit_continuation"
    ? authorizeRefresh(c, input)
    : authorized;
}

/** A shared URL retains each stored operation family's own money grants. */
export const operations = new Hono<{ Bindings: Env }>();
operations.use("*", unifiedAuthMiddleware());
operations.use("*", projectContextMiddleware({ allowUnentitledProduction: () => true }));

operations.get("/", requireAction("earn.read"), validateQuery(querySchema), async (c) => {
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
});

operations.get(
  "/:operationId",
  requireAction("earn.read"),
  validateParams(paramsSchema),
  authorize((c, input) => authorizeOperation(c, input, false)),
  async (c) => {
    const { record } = getAuthorized<AuthorizedOperation>(c);
    return success(c, {
      operation: await projectEarnOperation(c.env, record.scope, record.operation),
    });
  }
);

operations.post(
  "/:operationId/execute",
  requireAction("earn.execute"),
  validateParams(paramsSchema),
  validateBody(executeOperationSchema),
  authorize(authorizeExecution),
  idempotent({ key: "required", serverErrors: "rerun" }),
  async (c) => {
    const { record, preparation } = getAuthorized<AuthorizedOperation>(c);
    const body = executeOperationSchema.parse(await c.req.json());
    if (record.operation.buildRef?.kind === "earn.deposit_continuation") {
      if (
        preparation === null ||
        preparation.intent.kind !== "earn.deposit" ||
        body.signedTransaction !== undefined
      ) {
        throw badRequest("Review the deposit transaction after the swap completes");
      }
      const source = preparation.intent.source;
      const swap = await requirePreparedSwapStrategyTransaction(
        c.env,
        { ...record.scope, custodyWalletId: "walletId" in source ? source.walletId : null },
        record.operation.buildRef.id
      );
      if (swap.swap_chain_status !== "finalized")
        throw conflict("The deposit swap has not finalized");
      const continuation = swapStrategyContinuation(swap);
      if (continuation.strategyId !== preparation.intent.strategyId)
        throw conflict("Swap strategy identity changed");
      const service = createOperationsService(c.env);
      const claim = await service.claimExecution(record.scope, record.operation.id, body);
      await service.repository.release(record.scope, claim);
      const prepared = await prepareEarnStrategyAction(c, {
        ...preparation,
        intent: {
          ...preparation.intent,
          amount: { mint: continuation.depositTokenMint, value: continuation.minOutAmount },
        },
      });
      const operation = await service.repository.replacePreparedAction(
        record.scope,
        record.operation.id,
        record.operation,
        prepared,
        { kind: "never_dispatched" }
      );
      markIdempotencyCommitted(c);
      return success(c, { operation }, 202);
    }
    if (record.operation.buildRef?.kind === "earn.withdrawal_options") {
      if (
        preparation === null ||
        body.optionId === undefined ||
        body.signedTransaction !== undefined
      ) {
        throw badRequest("Choose a withdrawal option before reviewing its transaction");
      }
      const service = createOperationsService(c.env);
      const claim = await service.claimExecution(record.scope, record.operation.id, body);
      await service.repository.release(record.scope, claim);
      const prepared = await prepareEarnStrategyAction(c, preparation, body.optionId);
      const operation = await service.repository.replacePreparedAction(
        record.scope,
        record.operation.id,
        record.operation,
        prepared,
        { kind: "never_dispatched" }
      );
      markIdempotencyCommitted(c);
      return success(c, { operation }, 202);
    }
    return success(
      c,
      { operation: await executeEarnOperation(c.env, record.scope, record.operation.id, body, c) },
      202
    );
  }
);

operations.post(
  "/:operationId/refresh",
  requireAction("earn.execute"),
  validateParams(paramsSchema),
  validateBody(emptyBody),
  authorize(authorizeRefresh),
  idempotent({ key: "required", serverErrors: "rerun" }),
  async (c) => {
    const { record, preparation, cancellation } = getAuthorized<AuthorizedOperation>(c);
    if (isTerminalOperation(record.operation))
      return success(c, {
        operation: await projectEarnOperation(c.env, record.scope, record.operation),
      });
    if (preparation === null && !cancellation)
      throw badRequest("Operation has no refreshable action");
    const service = createOperationsService(c.env);
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
    const prepared = cancellation
      ? await prepareEarnOperationCancellation(c, cancellation, record)
      : preparation === null
        ? null
        : await prepareEarnStrategyAction(c, preparation);
    if (prepared === null) throw badRequest("Operation has no refreshable action");
    const evidence =
      reference?.kind === "custody.proposal" || reference?.kind === "custody.proposal_not_sent"
        ? { kind: "resolved_attempt" as const, resourceRef: reference }
        : { kind: "never_dispatched" as const };
    const operation =
      record.actionPurpose === "cancel"
        ? await service.prepareCancellation(
            record.scope,
            record.operation.id,
            record.operation,
            prepared,
            evidence
          )
        : await service.repository.replacePreparedAction(
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
  requireAction("earn.manage"),
  validateParams(paramsSchema),
  validateBody(emptyBody),
  authorize(async (c, input) => {
    const authorized = await authorizeOperation(c, input, true);
    return {
      ...authorized,
      cancellation: await authorizeEarnOperationCancellation(c, authorized.record),
    };
  }),
  idempotent({ key: "required", serverErrors: "rerun" }),
  async (c) => {
    const { record, cancellation } = getAuthorized<AuthorizedOperation>(c);
    const service = createOperationsService(c.env);
    let operation = await service.requestCancellation(record.scope, record.operation.id);
    markIdempotencyCommitted(c);
    if (isTerminalOperation(operation))
      return success(c, { operation: await projectEarnOperation(c.env, record.scope, operation) });
    if (record.actionPurpose === "cancel") return success(c, { operation }, 202);
    if (cancellation) {
      const prepared = await prepareEarnOperationCancellation(c, cancellation, record);
      operation = await service.prepareCancellation(
        record.scope,
        operation.id,
        operation,
        prepared,
        {
          kind: "resolved_attempt",
          resourceRef: { kind: "earn.withdrawal_request", id: cancellation.request.id },
        }
      );
      markIdempotencyCommitted(c);
      return success(c, { operation }, 202);
    }
    operation =
      (await service.repository.cancelUndispatched(record.scope, operation.id)) ?? operation;
    return success(
      c,
      { operation: await projectEarnOperation(c.env, record.scope, operation) },
      202
    );
  }
);
