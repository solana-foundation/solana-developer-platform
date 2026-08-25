/**
 * Background job: reconcile rings operations that have already been broadcast.
 *
 * Each tick sweeps in-flight operations:
 *  1. `submitted` → `executeOperation` advances it to `indexing` and polls in
 *     the same call. This is the crash-recovery path: the broadcast happens
 *     inside `submitted`, so a process that dies before the indexing
 *     transition commits leaves a live transaction here, and nothing else
 *     would ever look at it again.
 *  2. `indexing` → `executeOperation` polls `verifyIndexed` through the port;
 *     a hit completes the operation, a miss leaves it untouched (idempotent).
 *  3. `indexing` older than the timeout budget, and still not indexed after
 *     this tick's poll → failed, so nothing sits in limbo forever. A row with
 *     signed bytes fails as `manual_reconciliation_required` and is never
 *     retryable: nothing here established whether those bytes landed, and
 *     inviting another attempt is how the same payment is made twice.
 *
 * Ships dormant: the job early-returns unless the feature flag is on AND
 * HELIUS_RINGS_ADAPTER selects the live adapter. Until then no operation can
 * reach `indexing` in production anyway (the not-implemented gateway fails the
 * pipeline at `proving`).
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

const MAX_PER_RUN = 100;

export interface PollRingsIndexingDependencies {
  /** Test seam: service per tenant; production builds the real one. */
  createService?: (tenant: { organizationId: string; projectId: string }) => HeliusRingsService;
  now?: () => Date;
  /** Test seam for the reconciliation sweep's view of the chain. */
  readBlockHeight?: (input: { env: Env }) => Promise<string | null>;
}

export function isRingsIndexingPollEnabled(
  env: Pick<Env, "HELIUS_RINGS_ENABLED" | "HELIUS_RINGS_ADAPTER">
): boolean {
  return isHeliusRingsEnabled(env) && env.HELIUS_RINGS_ADAPTER === "ts";
}

export async function pollRingsIndexing(
  env: Env,
  dependencies: PollRingsIndexingDependencies = {}
): Promise<void> {
  if (!isRingsIndexingPollEnabled(env)) {
    return;
  }

  const now = dependencies.now ?? (() => new Date());
  const createService =
    dependencies.createService ??
    ((tenant: { organizationId: string; projectId: string }) =>
      createHeliusRingsService(env, tenant));

  const repository = createHeliusRingsOperationRepository(env);
  // Everything in flight as of this tick; the poll itself decides per state.
  const inFlight = await repository.listInFlightOperations({
    staleBefore: now().toISOString(),
    limit: MAX_PER_RUN,
  });

  const logger = getLogger();
  const timeoutCutoff = now().getTime() - RINGS_INDEXING_TIMEOUT_MS;

  // Operations whose signed bytes can no longer land are dealt with first, and
  // separately: they are not slow, they are finished, and what happens to them
  // depends on whether they consumed notes rather than on how long they waited.
  await escalateExpiredSubmissions(env, repository, dependencies, logger);

  // Then the reverse case: a row failed on an RPC timeout whose transaction
  // Photon has since indexed. Nothing else would ever look at it again, because
  // `failed` is not in-flight work — so it would hold its wallet's slot forever
  // over a payment that actually succeeded.
  await completeIndexedFailures(env, repository, dependencies, logger);

  // Deliberately sequential. executeOperation makes one Photon call per
  // operation, so fanning MAX_PER_RUN out would put 100 unthrottled requests at
  // the indexer every tick. It would not even buy much: the pool caps at 10
  // connections with a 5s acquire timeout, so the batch serializes there anyway
  // and any operation that waits longer is logged as a failure that never
  // happened. Serial also keeps listInFlightOperations' oldest-first ordering
  // meaningful when there is a backlog. The 60s tick against the 30-minute
  // indexing budget leaves ample headroom.
  //
  // Note this is not about error isolation: the catch below is per-operation and
  // would survive a Promise.all over the same body unchanged.
  for (const operation of inFlight) {
    // `submitted` rides along with `indexing`: executeOperation advances it and
    // polls in one call, which is the only thing that rescues a broadcast whose
    // indexing transition never committed. The timeout is deliberately not
    // applied to it — the budget measures how long Photon has been asked, and a
    // resumed operation has not been asked yet.
    if (operation.state !== "indexing" && operation.state !== "submitted") continue;
    try {
      const service = createService({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
      });

      // Photon first, always, even for a row past the budget. Being over the
      // budget says the indexer has been slow, not that it has nothing; failing
      // a row the very same tick could have completed manufactures operator
      // work for an operation that actually settled.
      const settled = await service.executeOperation(operation.id);
      if (settled.state === "completed") continue;

      if (operation.state === "indexing" && Date.parse(operation.updated_at) < timeoutCutoff) {
        await failIndexingTimeout(repository, operation);
      }
    } catch (error) {
      // One stuck operation must not starve the rest of the sweep.
      logger.warn(
        { operationId: operation.id, err: error },
        "rings indexing poll failed for operation"
      );
    }
  }
}

/**
 * Closes out operations whose blockhash has passed.
 *
 * Past the expiry there are only two possibilities — it landed, or it never
 * will — and Photon is asked first, because the recorded expiry is exact only
 * for a transfer or withdrawal. A shield and a merge take their blockhash from
 * the SDK's own builder, so theirs is a lower bound and the row may be expired
 * only on paper.
 *
 * When Photon still cannot confirm it, the operation is unresolvable from here
 * whatever it was going to do, and it is never marked retryable. An earlier
 * version made an exception for shields, on the grounds that a deposit consumes
 * no notes and so cannot double-spend. That confused two different things: a
 * deposit cannot spend a note twice, but it can absolutely execute twice, and
 * an owner who asked to shield one amount and had two leave their public
 * balance has lost the use of the difference.
 */
async function escalateExpiredSubmissions(
  env: Env,
  repository: ReturnType<typeof createHeliusRingsOperationRepository>,
  dependencies: PollRingsIndexingDependencies,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const readHeight = dependencies.readBlockHeight ?? readRingsBlockHeight;
  const blockHeight = await readHeight({ env });
  if (blockHeight === null) {
    logger.warn({}, "rings reconciliation sweep skipped: block height unavailable");
    return;
  }

  const expired = await repository.listExpiredSubmissions({ blockHeight, limit: MAX_PER_RUN });
  const createService =
    dependencies.createService ??
    ((tenant: { organizationId: string; projectId: string }) =>
      createHeliusRingsService(env, tenant));

  for (const operation of expired) {
    try {
      const settled = await createService({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
      }).executeOperation(operation.id);
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
      logger.warn(
        { operationId: operation.id, err: error },
        "rings reconciliation sweep failed for operation"
      );
    }
  }
}

/**
 * Completes a signed failure Photon turns out to hold.
 *
 * Safe to do without a human because Photon holding a transaction is positive
 * evidence, and it is the same authority the happy path already trusts. The
 * opposite conclusion is not symmetric: absence from an indexer is never proof
 * a transaction is dead, so this pass never voids anything. That decision stays
 * on the reconcile route, which checks the chain and the blockhash too.
 */
async function completeIndexedFailures(
  env: Env,
  repository: ReturnType<typeof createHeliusRingsOperationRepository>,
  dependencies: PollRingsIndexingDependencies,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  const createService =
    dependencies.createService ??
    ((tenant: { organizationId: string; projectId: string }) =>
      createHeliusRingsService(env, tenant));

  const signedFailures = await repository.listSignedFailures({ limit: MAX_PER_RUN });

  for (const operation of signedFailures) {
    try {
      // The route's own idempotent path: a Photon hit completes it, and
      // anything else leaves the row exactly as it is.
      await createService({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
      }).completeIfIndexed(operation.id);
    } catch (error) {
      logger.warn(
        { operationId: operation.id, err: error },
        "rings signed-failure sweep failed for operation"
      );
    }
  }
}

/**
 * The backstop for an operation Photon has never answered about.
 *
 * Reached when the reconciliation sweep did not close the row — most often
 * because the chain height was unavailable, sometimes because a backlog pushed
 * it past this tick's batch — and this tick's poll did not complete it either.
 * So nothing has established whether these bytes landed, and signed bytes are
 * never marked retryable here: the honest state is that a human has to look.
 *
 * `indexing_timeout` survives only for a row with no bytes behind it, which the
 * pipeline no longer produces but older rows may still be sitting in.
 */
async function failIndexingTimeout(
  repository: ReturnType<typeof createHeliusRingsOperationRepository>,
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
