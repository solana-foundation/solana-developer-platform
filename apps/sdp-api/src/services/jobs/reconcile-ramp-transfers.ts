/**
 * Background Job: Reconcile Ramp Transfers
 *
 * Webhooks are the primary settlement path for ramp transfers, but a webhook
 * can be lost (delivery failure, or the post-ack background write failing) and
 * a customer can abandon a hosted checkout without the provider ever creating
 * a transaction. This job is the backstop: for every provider that implements
 * `findSettlementEventByReference`, it pulls the provider's view of each stale
 * non-terminal ramp transfer and applies it through the same settlement-event
 * path the webhooks use, so the two delivery routes cannot diverge. A
 * `pending` transfer the provider has no record of past the abandonment
 * horizon was a checkout the customer never completed; it expires.
 */

import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampProvider } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import {
  createSystemPaymentsRepository,
  type PaymentTransferStatus,
  RAMP_TRANSFER_TYPES,
} from "@/db/repositories";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";

// Webhooks settle most transfers within seconds; only rows this stale are
// worth a provider lookup.
const MIN_AGE_MS = 5 * 60 * 1000;
// A hosted checkout the customer walked away from never produces a provider
// transaction. Past this horizon a still-pending transfer is abandoned.
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 50;

const RECONCILED_RAMP_STATUSES = [
  "pending",
  "awaiting_payment",
  "settling",
] as const satisfies readonly PaymentTransferStatus[];

export async function reconcileRampTransfers(env: Env): Promise<void> {
  const repo = createSystemPaymentsRepository(env);
  const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
  const stale = await repo.listTransfersByStatus({
    statuses: [...RECONCILED_RAMP_STATUSES],
    types: RAMP_TRANSFER_TYPES,
    updatedBefore: cutoff,
    limit: MAX_PER_RUN,
  });
  const transfers = stale.filter(
    (transfer) =>
      transfer.provider !== null &&
      transfer.provider_reference !== null &&
      (RAMP_PROVIDER_CLIENTS[transfer.provider] as RampProvider).findSettlementEventByReference !==
        undefined
  );
  if (transfers.length === 0) {
    return;
  }

  const projectEnvironments = new Map<string, SdpEnvironment>();
  const projects = new ProjectService(getDb(env));
  const resolveMode = async (projectId: string): Promise<SdpEnvironment> => {
    const cached = projectEnvironments.get(projectId);
    if (cached) {
      return cached;
    }
    const project = await projects.getProject(projectId);
    if (!project || (project.environment !== "sandbox" && project.environment !== "production")) {
      throw new Error(`Ramp transfer project ${projectId} has no resolvable environment`);
    }
    projectEnvironments.set(projectId, project.environment);
    return project.environment;
  };

  for (const transfer of transfers) {
    try {
      await reconcileTransfer(env, transfer, resolveMode);
    } catch (err) {
      getLogger().error(
        {
          transfer_id: transfer.id,
          provider: transfer.provider,
          error: err instanceof Error ? err.message : String(err),
        },
        "reconcileRampTransfers: failed to reconcile transfer"
      );
    }
  }
}

async function reconcileTransfer(
  env: Env,
  transfer: PaymentTransferRow,
  resolveMode: (projectId: string) => Promise<SdpEnvironment>
): Promise<void> {
  if (
    transfer.provider === null ||
    transfer.provider_reference === null ||
    transfer.project_id === null
  ) {
    return;
  }
  const client: RampProvider = RAMP_PROVIDER_CLIENTS[transfer.provider];
  if (client.findSettlementEventByReference === undefined) {
    return;
  }
  const mode = await resolveMode(transfer.project_id);
  const event = await client.findSettlementEventByReference(
    { env: env as unknown as Record<string, string | undefined>, mode },
    transfer.provider_reference
  );

  if (event === null) {
    const ageMs = Date.now() - Date.parse(transfer.created_at);
    if (transfer.status === "pending" && ageMs > ABANDONED_AFTER_MS) {
      await applyRampSettlementEvent(env, {
        provider: transfer.provider,
        kind: "expired",
        reference: transfer.provider_reference,
        error: "Checkout was never completed with the provider.",
      });
      logEvent("info", {
        event: "sdp_api_ramp_transfer_reconciled",
        flow: "ramp-reconciler",
        outcome: "expired_abandoned",
        organization_id: transfer.organization_id,
        project_id: transfer.project_id,
        transfer_id: transfer.id,
        provider: transfer.provider,
      });
    }
    return;
  }

  await applyRampSettlementEvent(env, event);
  logEvent("info", {
    event: "sdp_api_ramp_transfer_reconciled",
    flow: "ramp-reconciler",
    outcome: event.kind,
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    provider: transfer.provider,
  });
}
