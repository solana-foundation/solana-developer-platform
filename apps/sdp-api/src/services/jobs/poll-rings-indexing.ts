/**
 * Background job: poll Photon for rings operations stuck in `indexing`.
 *
 * Each tick sweeps in-flight operations:
 *  1. `indexing` → `executeOperation` polls `verifyIndexed` through the port;
 *     a hit completes the operation, a miss leaves it untouched (idempotent).
 *  2. `indexing` older than the timeout budget → `failed:indexing_timeout`
 *     (retryable) — the sweep never leaves an operation in limbo forever.
 *
 * Ships dormant: the job early-returns unless the feature flag is on AND
 * HELIUS_RINGS_ADAPTER is "http" — the live gateway selector Track B flips.
 * Until then no operation can reach `indexing` in production anyway (the
 * NotImplemented gateway fails the pipeline at `proving`).
 */

import {
  createHeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
} from "@/db/repositories";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { createHeliusRingsService, type HeliusRingsService } from "@/services/helius-rings";
import type { Env } from "@/types/env";

/** An operation may sit in `indexing` this long before it times out. */
export const RINGS_INDEXING_TIMEOUT_MS = 30 * 60 * 1000;

const MAX_PER_RUN = 100;

export interface PollRingsIndexingDependencies {
  /** Test seam: service per tenant; production builds the real one. */
  createService?: (tenant: { organizationId: string; projectId: string }) => HeliusRingsService;
  now?: () => Date;
}

export function isRingsIndexingPollEnabled(
  env: Pick<Env, "HELIUS_RINGS_ENABLED" | "HELIUS_RINGS_ADAPTER">
): boolean {
  return isHeliusRingsEnabled(env) && env.HELIUS_RINGS_ADAPTER === "http";
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

  for (const operation of inFlight) {
    if (operation.state !== "indexing") continue;
    try {
      if (Date.parse(operation.updated_at) < timeoutCutoff) {
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
