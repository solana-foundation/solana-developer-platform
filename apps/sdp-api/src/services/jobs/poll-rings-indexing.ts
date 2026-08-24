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
 *  3. `indexing` older than the timeout budget → `failed:indexing_timeout`
 *     (retryable) — the sweep never leaves an operation in limbo forever.
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
      if (operation.state === "indexing" && Date.parse(operation.updated_at) < timeoutCutoff) {
        await failIndexingTimeout(repository, operation);
        continue;
      }
      const service = createService({
        organizationId: operation.organization_id,
        projectId: operation.project_id,
      });
      await service.executeOperation(operation.id);
    } catch (error) {
      // One stuck operation must not starve the rest of the sweep.
      logger.warn(
        { operationId: operation.id, err: error },
        "rings indexing poll failed for operation"
      );
    }
  }
}

/** Op types that consumed notes, and so cannot be safely re-planned. */
const SPENDS = new Set(["transfer_registered", "withdraw", "merge"]);

/**
 * Closes out operations whose blockhash has passed.
 *
 * Past the expiry there are only two possibilities — it landed, or it never
 * will — and no way to tell them apart from here. What separates the two
 * outcomes is what the operation consumed:
 *
 *  - A shield created notes. If it never landed, nothing moved and re-attempting
 *    it is safe, so it fails retryably.
 *  - A transfer, withdrawal or merge consumed notes. If it did land, rebuilding
 *    would pay the recipient a second time, and the pinned inputs would refuse
 *    to reselect anyway. It fails as `manual_reconciliation_required`: an
 *    operator reconciles the signature against the chain by hand.
 *
 * Without this, both sat in `indexing` until the 30-minute budget expired and
 * were then marked retryable — offering exactly the retry that double-pays.
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
    const spend = SPENDS.has(operation.op_type);
    try {
      // Ask Photon before writing anything off. The recorded expiry is exact
      // for a transfer or withdrawal, but a shield and a merge take their
      // blockhash from the SDK's own builder, so theirs is a lower bound and
      // this row may be expired only on paper. Escalating without checking
      // would mark a landed deposit retryable and invite a second one.
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
        code: spend ? "manual_reconciliation_required" : "indexing_timeout",
        message: spend
          ? `signed transaction ${operation.outer_tx_signature} expired without being indexed; reconcile it on chain before retrying`
          : "the deposit's blockhash expired before it was indexed",
        retryable: !spend,
      });
    } catch (error) {
      logger.warn(
        { operationId: operation.id, err: error },
        "rings reconciliation sweep failed for operation"
      );
    }
  }
}

async function failIndexingTimeout(
  repository: ReturnType<typeof createHeliusRingsOperationRepository>,
  operation: HeliusRingsOperationRow
): Promise<void> {
  await repository.failOperation({
    organizationId: operation.organization_id,
    projectId: operation.project_id,
    id: operation.id,
    expectedState: "indexing",
    code: "indexing_timeout",
    message: "Photon did not index the transaction within the budget",
    retryable: true,
  });
}
