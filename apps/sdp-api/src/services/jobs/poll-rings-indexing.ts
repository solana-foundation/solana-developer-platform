/**
 * Background job: reconcile rings operations that have already been broadcast.
 *
 * Failing a `ready_to_sign` row is safe because the pipeline broadcasts only
 * after the transition out of it commits, so nothing there reached an RPC.
 * Timeouts need only the database, so they are not gated on the upstreams: a
 * half-configured deployment still ages out stranded rows.
 */

import {
  createHeliusRingsOperationRepository,
  type HeliusRingsOperationRow,
} from "@/db/repositories";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { createHeliusRingsService, type HeliusRingsService } from "@/services/helius-rings";
import { ringsUpstreamsConfigured } from "@/services/helius-rings/gateway";
import type { Env } from "@/types/env";

/** An operation may sit in `indexing` this long before it times out. */
export const RINGS_INDEXING_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * An operation may sit in `ready_to_sign` this long before it is abandoned. Far
 * shorter than the indexing budget: this window covers one custody signature
 * and a decode rather than a wait on Photon.
 */
export const RINGS_SIGNING_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_PER_RUN = 100;

export interface PollRingsIndexingDependencies {
  /** Test seam: service per tenant; production builds the real one. */
  createService?: (tenant: { organizationId: string; projectId: string }) => HeliusRingsService;
  now?: () => Date;
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
  const createService =
    dependencies.createService ??
    ((tenant: { organizationId: string; projectId: string }) =>
      createHeliusRingsService(env, tenant));

  const repository = createHeliusRingsOperationRepository(env);
  const inFlight = await repository.listInFlightOperations({
    staleBefore: now().toISOString(),
    limit: MAX_PER_RUN,
  });

  const logger = getLogger();
  const timeoutCutoff = now().getTime() - RINGS_INDEXING_TIMEOUT_MS;
  const signingCutoff = now().getTime() - RINGS_SIGNING_TIMEOUT_MS;
  const canReachPhoton = ringsUpstreamsConfigured(env);

  // Deliberately sequential: one Photon call per operation, so a fan-out would
  // put MAX_PER_RUN unthrottled requests at the indexer every tick while the
  // 10-connection pool serialized them anyway.
  for (const operation of inFlight) {
    try {
      // Aged out rather than polled: nothing was ever broadcast for this row.
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
      // Timeouts are local. Photon reconciliation needs the upstreams.
      if (!canReachPhoton) {
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
