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
 *  4. `ready_to_sign` older than its budget → `failed:signer_failed`
 *     (retryable). Unlike the three above this one has no transaction to
 *     reconcile: the pipeline broadcasts only after the transition out of
 *     `ready_to_sign` commits, so an operation that died in this window never
 *     reached an RPC. The row is stale state rather than a lost payment, which
 *     is what makes failing it outright safe — and retryable honest, since
 *     rebuilding it cannot duplicate anything.
 *
 * Ships dormant: the job early-returns unless the feature flag is on AND every
 * Rings upstream is configured. Without the second check a half-configured
 * deployment would log one warning per in-flight operation every minute, since
 * the unconfigured gateway fails the pipeline at `proving` and the catch below
 * is per-operation.
 */

import {
  createHeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
} from "@/db/repositories";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { createHeliusRingsService, type HeliusRingsService } from "@/services/helius-rings";
import { type RingsUpstreamEnv, ringsUpstreamsConfigured } from "@/services/helius-rings/gateway";
import type { Env } from "@/types/env";

/** An operation may sit in `indexing` this long before it times out. */
export const RINGS_INDEXING_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * An operation may sit in `ready_to_sign` this long before it is abandoned.
 *
 * Far shorter than the indexing budget, and for a different reason: indexing
 * waits on Photon, while this window covers one custody signature and a decode.
 * Anything still here after ten minutes is the remains of a process that died,
 * not work in progress.
 */
export const RINGS_SIGNING_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_PER_RUN = 100;

export interface PollRingsIndexingDependencies {
  /** Test seam: service per tenant; production builds the real one. */
  createService?: (tenant: { organizationId: string; projectId: string }) => HeliusRingsService;
  now?: () => Date;
}

export function isRingsIndexingPollEnabled(
  env: Pick<Env, "HELIUS_RINGS_ENABLED"> & RingsUpstreamEnv
): boolean {
  return isHeliusRingsEnabled(env) && ringsUpstreamsConfigured(env);
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
  const signingCutoff = now().getTime() - RINGS_SIGNING_TIMEOUT_MS;

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
    if (
      operation.state !== "indexing" &&
      operation.state !== "submitted" &&
      operation.state !== "ready_to_sign"
    ) {
      continue;
    }
    try {
      // Aged out rather than polled: there is no external condition to ask
      // about, because nothing was ever broadcast for this row.
      if (operation.state === "ready_to_sign") {
        if (Date.parse(operation.updated_at) < signingCutoff) {
          await failSigningTimeout(repository, operation);
        }
        continue;
      }
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

async function failSigningTimeout(
  repository: ReturnType<typeof createHeliusRingsOperationRepository>,
  operation: HeliusRingsOperationRow
): Promise<void> {
  await repository.failOperation({
    organizationId: operation.organization_id,
    projectId: operation.project_id,
    id: operation.id,
    expectedState: "ready_to_sign",
    code: "signer_failed",
    message: "the operation was abandoned before its signature was recorded; nothing was broadcast",
    retryable: true,
  });
}
