/**
 * Background job: settle rings operations that have already been broadcast.
 *
 * Each tick runs four passes:
 *  1. Signed bytes whose blockhash has expired — they either landed or never
 *     will, so Photon is asked once and anything unconfirmed becomes
 *     `manual_reconciliation_required`.
 *  2. Signed failures (e.g. `submit_failed`) whose blockhash has expired —
 *     Photon is asked once, then the failure code is upgraded so an operator
 *     can void the wallet's blocked slot.
 *  3. Signed failures Photon has since indexed, completed from that positive
 *     evidence. Never the reverse: absence from an indexer is not proof.
 *  4. In-flight rows, advanced by `executeOperation`, with `indexing` past the
 *     budget failed so nothing sits in limbo.
 *
 * Ships dormant: early-returns unless the feature flag is on.
 */

import {
  createHeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
} from "@/db/repositories";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { createHeliusRingsService, type HeliusRingsService } from "@/services/helius-rings";
import { readRingsBlockHeight } from "@/services/helius-rings/rpc-adapter";
import type { Env } from "@/types/env";

/** An operation may sit in `indexing` this long before it times out. */
export const RINGS_INDEXING_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * How long an operation with no durable bytes is left alone before the sweep
 * treats it as abandoned.
 *
 * The request that owns an operation holds no lease the sweep can see, so a
 * row mid-build or mid-signing is indistinguishable from one whose owner
 * crashed. Resuming the former destroys it: `ready_to_sign` without bytes is
 * read as "signing died" when it usually means custody has not answered yet.
 * Waiting costs a sweep or two on a genuine crash; not waiting fails
 * operations out from under the request that is still working on them.
 */
export const RINGS_UNSIGNED_GRACE_MS = 2 * 60 * 1000;

const MAX_PER_RUN = 100;

/**
 * Whether resuming would rebuild or fail the operation rather than rebroadcast
 * it. Recorded bytes make a resume idempotent at any age, so only a row without
 * them has to wait out the grace.
 */
function resumeIsDestructive(operation: HeliusRingsOperationRow): boolean {
  if (operation.signed_transaction !== null) return false;
  return operation.state === "proving" || operation.state === "ready_to_sign";
}

type OperationRepository = ReturnType<typeof createHeliusRingsOperationRepository>;
type Logger = ReturnType<typeof getLogger>;
type ServiceFor = (tenant: { organizationId: string; projectId: string }) => HeliusRingsService;

export interface PollRingsIndexingDependencies {
  /** Test seam: service per tenant; production builds the real one. */
  createService?: ServiceFor;
  now?: () => Date;
  /** Test seam for the expiry pass's view of the chain. */
  readBlockHeight?: (input: { env: Env }) => Promise<string | null>;
}

export function isRingsIndexingPollEnabled(env: Pick<Env, "HELIUS_RINGS_ENABLED">): boolean {
  return isHeliusRingsEnabled(env);
}

export async function pollRingsIndexing(
  env: Env,
  dependencies: PollRingsIndexingDependencies = {}
): Promise<void> {
  if (!isRingsIndexingPollEnabled(env)) {
    return;
  }

  const now = dependencies.now ?? (() => new Date());
  const createService: ServiceFor =
    dependencies.createService ?? ((tenant) => createHeliusRingsService(env, tenant));
  const serviceFor = (operation: HeliusRingsOperationRow) =>
    createService({
      organizationId: operation.organization_id,
      projectId: operation.project_id,
    });

  const repository = createHeliusRingsOperationRepository(env);
  const logger = getLogger();

  const blockHeight = await (dependencies.readBlockHeight ?? readRingsBlockHeight)({ env });
  if (blockHeight === null) {
    logger.warn({}, "rings expiry pass skipped: block height unavailable");
  } else {
    await escalateExpiredSubmissions(repository, serviceFor, logger, blockHeight);
    await escalateExpiredSignedFailures(repository, serviceFor, logger, blockHeight);
  }

  await completeIndexedFailures(repository, serviceFor, logger);
  await advanceInFlight(repository, serviceFor, logger, now());
}

/**
 * Closes out operations whose blockhash has passed.
 *
 * Photon is asked first, because the recorded expiry is exact only for a spend:
 * a shield takes its blockhash from the SDK's own builder, so its stored height
 * is a lower bound and the row may be expired only on paper.
 *
 * Anything still unconfirmed is unresolvable from here and never retryable. A
 * deposit cannot spend a note twice, but it can execute twice, and an owner who
 * asked to shield one amount and had two leave their public balance has lost
 * the difference.
 */
async function escalateExpiredSubmissions(
  repository: OperationRepository,
  serviceFor: (operation: HeliusRingsOperationRow) => HeliusRingsService,
  logger: Logger,
  blockHeight: string
): Promise<void> {
  const expired = await repository.listExpiredSubmissions({ blockHeight, limit: MAX_PER_RUN });

  for (const operation of expired) {
    try {
      const settled = await serviceFor(operation).executeOperation(operation.id);
      if (settled.state === "completed") continue;

      await repository.failOperation({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
        id: operation.id,
        expectedState: operation.state as "submitted" | "indexing",
        code: "manual_reconciliation_required",
        message: `signed transaction ${operation.outer_tx_signature} expired without being indexed; reconcile it on chain before starting another`,
        retryable: false,
      });
    } catch (error) {
      logger.warn({ operationId: operation.id, err: error }, "rings expiry pass failed");
    }
  }
}

/**
 * Escalates a signed failure whose blockhash has passed.
 *
 * A row failed during broadcast (submit_failed, gateway_unavailable) but
 * with signed bytes on it holds the wallet's spend slot forever: void requires
 * `manual_reconciliation_required`. This pass upgrades the code once the
 * blockhash has expired, so the operator can reconcile against the chain.
 */
async function escalateExpiredSignedFailures(
  repository: OperationRepository,
  serviceFor: (operation: HeliusRingsOperationRow) => HeliusRingsService,
  logger: Logger,
  blockHeight: string
): Promise<void> {
  const expired = await repository.listExpiredSignedFailures({ blockHeight, limit: MAX_PER_RUN });
  for (const operation of expired) {
    try {
      await serviceFor(operation).escalateToManualReconciliation(operation.id);
    } catch (error) {
      logger.warn(
        { operationId: operation.id, err: error },
        "rings signed-failure escalation failed"
      );
    }
  }
}

/**
 * Completes a signed failure Photon turns out to hold.
 *
 * Safe without a human because Photon holding a transaction is positive
 * evidence from the same authority the happy path already trusts. The opposite
 * conclusion is not symmetric, so this pass never voids anything — that stays
 * with the operator, on the void route.
 */
async function completeIndexedFailures(
  repository: OperationRepository,
  serviceFor: (operation: HeliusRingsOperationRow) => HeliusRingsService,
  logger: Logger
): Promise<void> {
  const signedFailures = await repository.listSignedFailures({ limit: MAX_PER_RUN });

  for (const operation of signedFailures) {
    try {
      await serviceFor(operation).completeIfIndexed(operation.id);
    } catch (error) {
      logger.warn({ operationId: operation.id, err: error }, "rings signed-failure sweep failed");
    }
  }
}

/**
 * Drives in-flight operations forward, failing `indexing` past the budget.
 *
 * Deliberately sequential: `executeOperation` makes one Photon call each, so
 * fanning MAX_PER_RUN out would put 100 unthrottled requests at the indexer
 * every tick, and the 10-connection pool would serialize them anyway. Serial
 * also keeps the repository's oldest-first ordering meaningful under a backlog.
 */
async function advanceInFlight(
  repository: OperationRepository,
  serviceFor: (operation: HeliusRingsOperationRow) => HeliusRingsService,
  logger: Logger,
  now: Date
): Promise<void> {
  const inFlight = await repository.listInFlightOperations({
    staleBefore: now.toISOString(),
    limit: MAX_PER_RUN,
  });
  const timeoutCutoff = now.getTime() - RINGS_INDEXING_TIMEOUT_MS;
  const graceCutoff = now.getTime() - RINGS_UNSIGNED_GRACE_MS;

  // `proving`, `ready_to_sign` and `submitted` ride along with `indexing`: a
  // crash leaves an operation in one of them holding its wallet's slot, and
  // nothing else would look at it again. The budget below still applies only to
  // `indexing`, the only state measuring how long Photon has been asked.
  for (const operation of inFlight) {
    if (resumeIsDestructive(operation) && Date.parse(operation.updated_at) > graceCutoff) continue;
    try {
      // Photon first, even past the budget. Being over it says the indexer has
      // been slow, not that it has nothing, and failing a row that would have
      // completed this same tick manufactures operator work.
      const settled = await serviceFor(operation).executeOperation(operation.id);
      if (settled.state === "completed") continue;

      if (operation.state === "indexing" && Date.parse(operation.updated_at) < timeoutCutoff) {
        await failIndexingTimeout(repository, operation);
      }
    } catch (error) {
      // One stuck operation must not starve the rest of the sweep.
      logger.warn({ operationId: operation.id, err: error }, "rings indexing poll failed");
    }
  }
}

/**
 * The backstop for an operation Photon has never answered about.
 *
 * Signed bytes are never retryable here: nothing established whether they
 * landed, so the honest state is that a human has to look. `indexing_timeout`
 * survives only for a row with no bytes behind it, which the pipeline no longer
 * produces but older rows may still be sitting in.
 */
async function failIndexingTimeout(
  repository: OperationRepository,
  operation: HeliusRingsOperationRow
): Promise<void> {
  const unresolvable = operation.signed_transaction !== null;

  await repository.failOperation({
    organizationId: operation.organization_id,
    projectId: operation.project_id,
    id: operation.id,
    expectedState: "indexing",
    code: unresolvable ? "manual_reconciliation_required" : "indexing_timeout",
    message: unresolvable
      ? `Photon did not index ${operation.outer_tx_signature} within the budget; reconcile it on chain before starting another`
      : "Photon did not index the transaction within the budget",
    retryable: !unresolvable,
  });
}
