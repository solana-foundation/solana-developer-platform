import { runInClusterScope } from "@sdp/rpc/scope";
import type { Next } from "hono";
import { notFound } from "@/lib/errors";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getEarnRepository, hasEarnAuth } from "./context";
import { anonymousExitNeedsStrategy } from "./handlers/external-wallet";
import { parseParams, parseQuery } from "./handlers/shared";
import {
  earnCatalogueEnvironmentQuerySchema,
  type earnExternalWalletDepositTransactionSchema,
  type earnExternalWalletQueuedWithdrawalPreviewSchema,
  type earnExternalWalletWithdrawalOptionsSchema,
  type earnExternalWalletWithdrawalPreviewSchema,
  type earnExternalWalletWithdrawalTransactionSchema,
  earnStrategyIdParamsSchema,
  type earnVaultDepositPreviewSchema,
} from "./schemas";

// Anonymous Earn is one of the cluster-scope entry points (ADR 0007): a keyless
// request has no project, so it opens its scope from the shelf it names. Keyed
// requests already run in their project's scope (`projectContextMiddleware`)
// and pass through, so no request opens two. Each opener sits directly before
// its handler, so a request refused earlier (validation, quotas) costs no
// strategy lookup.

/**
 * Open a keyless catalogue list's cluster scope from the `?environment=` it must name.
 *
 * @param c - The request context.
 * @param next - The rest of the route chain.
 * @returns Resolves when the chain has run.
 * @throws AppError `BAD_REQUEST` when a keyless caller omits `environment` or names an unknown one.
 */
export async function openKeylessCatalogueScope(c: AppContext, next: Next): Promise<void> {
  if (hasEarnAuth(c)) {
    await next();
    return;
  }
  const { environment } = parseQuery(c, earnCatalogueEnvironmentQuerySchema);
  await runInClusterScope({ projectId: null, environment }, next);
}

/**
 * Open a keyless strategy read's cluster scope from the `:strategyId` it names.
 *
 * @param c - The request context.
 * @param next - The rest of the route chain.
 * @returns Resolves when the chain has run.
 * @throws AppError `NOT_FOUND` when no strategy has that id.
 */
export async function openKeylessStrategyParamScope(c: AppContext, next: Next): Promise<void> {
  if (hasEarnAuth(c)) {
    await next();
    return;
  }
  const { strategyId } = parseParams(c, earnStrategyIdParamsSchema);
  await runInStrategyScope(c, strategyId, next);
}

/** A keyless quote or build body: it names a strategy, or a keyed-only position on exits. */
type KeylessStrategyBodySchema =
  | typeof earnVaultDepositPreviewSchema
  | typeof earnExternalWalletDepositTransactionSchema
  | typeof earnExternalWalletWithdrawalPreviewSchema
  | typeof earnExternalWalletWithdrawalTransactionSchema
  | typeof earnExternalWalletWithdrawalOptionsSchema
  | typeof earnExternalWalletQueuedWithdrawalPreviewSchema;

/**
 * Open a keyless quote or build's cluster scope from the `strategyId` in its validated body. An
 * exit that names only a `positionId` is refused with the exit resolver's own 400: a position is a
 * tenant row a keyless caller cannot address.
 *
 * @param c - The request context, after `validateBody`.
 * @param next - The rest of the route chain.
 * @returns Resolves when the chain has run.
 * @throws AppError `BAD_REQUEST` when a keyless body names no strategy; `NOT_FOUND` when no
 *   strategy has that id.
 */
export async function openKeylessStrategyBodyScope(
  c: ValidatedBodyContext<KeylessStrategyBodySchema>,
  next: Next
): Promise<void> {
  if (hasEarnAuth(c)) {
    await next();
    return;
  }
  const body = c.req.valid("json");
  if (!("strategyId" in body)) throw anonymousExitNeedsStrategy();
  await runInStrategyScope(c, body.strategyId, next);
}

/**
 * Run the rest of a keyless chain in the cluster scope of the strategy row it names: the row's
 * `environment` decides the cluster, so a sandbox row runs on devnet and a production row on
 * mainnet whatever the deployment. The handler loads the row again through
 * `requireEarnStrategyForCaller`, which checks it against this scope.
 */
async function runInStrategyScope(c: AppContext, strategyId: string, next: Next): Promise<void> {
  const strategy = await getEarnRepository(c).getStrategyById(strategyId);
  if (!strategy) throw notFound("Earn strategy");
  await runInClusterScope({ projectId: null, environment: strategy.environment }, next);
}
