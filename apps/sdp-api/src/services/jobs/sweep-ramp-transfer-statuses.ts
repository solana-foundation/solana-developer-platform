import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type {
  RampRuntimeContext,
  RampSettlementEvent,
  RampTransferLookup,
} from "@sdp/payments/ramps/types";
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import {
  OPEN_PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES,
  type PaymentTransferStatus,
  RAMP_TRANSFER_TRANSITIONS,
  type RampTransferType,
  type RampWebhookProcessResult,
} from "@sdp/types/payments";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import type {
  PaymentsRepository,
  RampPaymentTransferRow,
} from "@/db/repositories/payments.repository";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { logEvent, paymentsErrorDiagnostics } from "@/runtime/money-path-events";
import { isProviderConfigured } from "@/services/provider-availability.service";
import type { WebhookProcessor } from "@/services/ramps/webhooks/processor";
import { RAMP_PROVIDER_WEBHOOK_PROCESSOR } from "@/services/ramps/webhooks/registry";
import type { Env } from "@/types/env";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Provider requests one sweep may make per provider: one per transfer it asks about. */
export const RAMP_STATUS_PULLS_PER_SWEEP = 25;

/** Webhooks get the first word: MoonPay retries a failed delivery for about nine minutes. */
const WEBHOOK_GRACE_MS = 10 * MINUTE_MS;
/** How often an open transfer is asked about again. */
const OPEN_REPOLL_MS = 15 * MINUTE_MS;
/** How often an expired transfer is asked about, and for how long after it went quiet. */
const EXPIRED_REPOLL_MS = HOUR_MS;
const REVIVAL_WINDOW_MS = 14 * 24 * HOUR_MS;
/** No pull starts after this, so a slow provider cannot run into the next slot. */
const SWEEP_BUDGET_MS = 4 * MINUTE_MS;

/**
 * How long a checkout may go without provider activity before SDP expires it.
 * Product defaults, not provider facts (HOO-2040); expiry is revivable either way.
 */
export const RAMP_ABANDONMENT_HORIZON_MS = {
  // A bank-funded buy can sit in `waitingPayment` for days. An unclaimed sale
  // moves nothing once expired: SDP holds the crypto it would deposit.
  moonpay: { onramp: 72 * HOUR_MS, offramp: 24 * HOUR_MS },
  // Stripe runs onramp only.
  stripe: { onramp: 24 * HOUR_MS, offramp: 24 * HOUR_MS },
} as const satisfies Record<RampProviderId, Record<RampTransferType, number>>;

/**
 * What one pulled event came to: the processor's result, skipped as no news, or
 * held because the provider reported a status SDP cannot read.
 */
type RampStatusPullOutcome =
  | RampWebhookProcessResult
  | { outcome: "skipped" }
  | { outcome: "unmapped"; status: string };

/** Asks one provider about one transfer and applies each event as its webhook would. */
type RampStatusPull = (
  ctx: RampRuntimeContext,
  env: Env,
  environment: SdpEnvironment,
  lookup: RampTransferLookup
) => Promise<RampStatusPullOutcome[]>;

/**
 * Whether a pulled event only repeats that the customer has not paid. An untimed
 * provider (Stripe) reports that on every pull with no way to tell when it
 * became true, so it never counts as activity: applying it would restart the
 * abandonment clock, or revive an expired checkout, on every pull.
 */
function isUntimedNoNews(event: RampSettlementEvent): boolean {
  return event.kind === "awaiting_payment" && event.providerObservedAt === undefined;
}

/**
 * Pairs a provider client's status pull with that provider's webhook processor,
 * so a pulled event takes exactly the path a delivered webhook does.
 */
function statusPull<Event extends RampSettlementEvent>(
  client: {
    fetchTransferStatus(
      ctx: RampRuntimeContext,
      lookup: RampTransferLookup
    ): Promise<readonly Event[]>;
  },
  processor: WebhookProcessor<Event>
): RampStatusPull {
  return async (ctx, env, environment, lookup) => {
    const outcomes: RampStatusPullOutcome[] = [];
    for (const event of await client.fetchTransferStatus(ctx, lookup)) {
      if (event.kind === "ignore" && event.unmappedStatus !== undefined) {
        outcomes.push({ outcome: "unmapped", status: event.unmappedStatus });
      } else if (isUntimedNoNews(event)) {
        outcomes.push({ outcome: "skipped" });
      } else {
        outcomes.push(await processor.process(env, environment, event));
      }
    }
    return outcomes;
  };
}

const RAMP_STATUS_PULLS = {
  moonpay: statusPull(RAMP_PROVIDER_CLIENTS.moonpay, RAMP_PROVIDER_WEBHOOK_PROCESSOR.moonpay),
  stripe: statusPull(RAMP_PROVIDER_CLIENTS.stripe, RAMP_PROVIDER_WEBHOOK_PROCESSOR.stripe),
} as const satisfies Record<RampProviderId, RampStatusPull>;

/** One provider's tally for one sweep. */
export interface RampStatusSweepResult {
  provider: RampProviderId;
  /** Transfers asked about, so provider requests. */
  polled: number;
  applied: number;
  expired: number;
  /** Pulls that threw: SDP could not ask, so nothing reads as absence. */
  failed: number;
  /** Events the settlement guard refused or could not match. */
  refused: number;
  /** Events in a provider status SDP has no mapping for: held, never expired. */
  unmapped: number;
}

/** The string values of the process env, which is where provider credentials live. */
function providerEnv(env: Env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

/**
 * Whether SDP should now call a checkout abandoned: still waiting on the
 * customer, nothing this pull said counts as activity, needs an operator, or is
 * a status SDP cannot read, and no provider activity for the provider's horizon.
 */
function isAbandoned(
  provider: RampProviderId,
  transfer: RampPaymentTransferRow,
  outcomes: readonly RampStatusPullOutcome[],
  now: number
): boolean {
  if (!RAMP_TRANSFER_TRANSITIONS.checkout_abandoned.from.some((s) => s === transfer.status)) {
    return false;
  }
  if (outcomes.some(({ outcome }) => outcome !== "ignored" && outcome !== "skipped")) {
    return false;
  }
  return (
    Date.parse(transfer.updated_at) <= now - RAMP_ABANDONMENT_HORIZON_MS[provider][transfer.type]
  );
}

/**
 * Expires an abandoned checkout, but only while the row is still as the pull
 * read it, so a webhook that just landed wins. An expired sale stops offering
 * its deposit wallet.
 */
async function expireAbandonedCheckout(
  repo: PaymentsRepository,
  transfer: RampPaymentTransferRow
): Promise<boolean> {
  const update: Parameters<PaymentsRepository["transitionRampTransfer"]>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    transition: "checkout_abandoned",
    expectedUpdatedAt: transfer.updated_at,
    updatedAt: new Date().toISOString(),
  };
  if (transfer.type === "offramp") {
    update.providerData = { cryptoDeposit: null };
  }
  return (await repo.transitionRampTransfer(update)) !== null;
}

async function pullTransfer(
  env: Env,
  credentials: Record<string, string>,
  repo: PaymentsRepository,
  provider: RampProviderId,
  claimed: { transfer: RampPaymentTransferRow; environment: SdpEnvironment },
  result: RampStatusSweepResult
): Promise<void> {
  const { transfer, environment } = claimed;
  let outcomes: RampStatusPullOutcome[];
  try {
    outcomes = await RAMP_STATUS_PULLS[provider](
      { env: credentials, mode: environment },
      env,
      environment,
      {
        transferId: transfer.id,
        rampType: transfer.type,
        providerReference: transfer.provider_reference,
      }
    );
  } catch (error) {
    result.failed += 1;
    logEvent("warn", {
      event: "sdp_api_ramp_status_pull_failed",
      flow: "ramp-settlement",
      provider,
      transfer_id: transfer.id,
      environment,
      error: error instanceof Error ? error.message : String(error),
      error_diagnostics: paymentsErrorDiagnostics(error),
    });
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.outcome === "applied") {
      result.applied += 1;
    }
    if (outcome.outcome === "refused" || outcome.outcome === "unmatched") {
      result.refused += 1;
      logEvent("warn", {
        event: "sdp_api_ramp_status_pull_refused",
        flow: "ramp-settlement",
        provider,
        transfer_id: transfer.id,
        environment,
        outcome: outcome.outcome,
        reason: outcome.reason,
      });
    }
    if (outcome.outcome === "unmapped") {
      result.unmapped += 1;
      logEvent("warn", {
        event: "sdp_api_ramp_status_pull_unmapped",
        flow: "ramp-settlement",
        provider,
        transfer_id: transfer.id,
        environment,
        provider_status: outcome.status,
      });
    }
  }
  if (
    isAbandoned(provider, transfer, outcomes, Date.now()) &&
    (await expireAbandonedCheckout(repo, transfer))
  ) {
    result.expired += 1;
    logEvent("info", {
      event: "sdp_api_ramp_checkout_abandoned",
      flow: "ramp-settlement",
      provider,
      transfer_id: transfer.id,
      environment,
      from_status: transfer.status,
    });
  }
}

/**
 * The two queues one provider's sweep drains in order: open transfers first, so
 * a pile of abandoned checkouts never starves a live one, then expired ones
 * that went quiet recently enough to be revived.
 */
function sweepQueues(now: number): {
  statuses: readonly PaymentTransferStatus[];
  polledBefore: string;
  updatedAfter: string | undefined;
}[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  return [
    {
      statuses: OPEN_PROVIDER_OBSERVABLE_RAMP_TRANSFER_STATUSES,
      polledBefore: iso(now - OPEN_REPOLL_MS),
      updatedAfter: undefined,
    },
    {
      statuses: [RAMP_TRANSFER_TRANSITIONS.checkout_abandoned.to],
      polledBefore: iso(now - EXPIRED_REPOLL_MS),
      updatedAfter: iso(now - REVIVAL_WINDOW_MS),
    },
  ];
}

async function sweepProvider(
  env: Env,
  credentials: Record<string, string>,
  repo: PaymentsRepository,
  provider: RampProviderId,
  deadline: number
): Promise<RampStatusSweepResult> {
  const result: RampStatusSweepResult = {
    provider,
    polled: 0,
    applied: 0,
    expired: 0,
    failed: 0,
    refused: 0,
    unmapped: 0,
  };
  // SDP holds sandbox keys only: production rows wait for project credentials
  // (HOO-1942, HOO-1943) and are neither pulled nor expired until then.
  const environments = SDP_ENVIRONMENTS.filter((environment) =>
    isProviderConfigured(env, "ramps", provider, environment === "sandbox")
  );
  if (environments.length === 0) {
    return result;
  }
  const now = Date.now();
  for (const queue of sweepQueues(now)) {
    while (result.polled < RAMP_STATUS_PULLS_PER_SWEEP && Date.now() < deadline) {
      const claimed = await repo.claimRampTransferForStatusPull({
        provider,
        environments,
        statuses: queue.statuses,
        updatedBefore: new Date(now - WEBHOOK_GRACE_MS).toISOString(),
        polledBefore: queue.polledBefore,
        updatedAfter: queue.updatedAfter,
        polledAt: new Date().toISOString(),
      });
      if (claimed === null) {
        break;
      }
      result.polled += 1;
      await pullTransfer(env, credentials, repo, provider, claimed, result);
    }
  }
  if (result.polled > 0) {
    logEvent("info", { event: "sdp_api_ramp_status_sweep", flow: "ramp-settlement", ...result });
  }
  return result;
}

/**
 * Asks each ramp provider about the transfers its webhooks may have missed and
 * applies what it says through that provider's own webhook processor, then
 * expires checkouts that went quiet past their horizon (HOO-2040). Providers
 * run side by side, each sequentially and capped, so one slow provider delays
 * nobody else. A provider the release channel hides is still swept: its open
 * transfers must still finish (`docs/contributing/ramp-provider-safety.md`).
 *
 * @param env - Process environment.
 * @param repo - System payments repository.
 * @returns One tally per provider.
 */
export async function sweepRampTransferStatuses(
  env: Env,
  repo: PaymentsRepository = createSystemPaymentsRepository(env)
): Promise<RampStatusSweepResult[]> {
  const credentials = providerEnv(env);
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  // Settled, not raced: a failing provider fails the run only after the others finish.
  const settled = await Promise.allSettled(
    RAMP_PROVIDERS.map((provider) => sweepProvider(env, credentials, repo, provider, deadline))
  );
  const results: RampStatusSweepResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      throw outcome.reason;
    }
    results.push(outcome.value);
  }
  return results;
}
