import type {
  RampWebhookFailureOutcome,
  RampWebhookProcessResult,
  SdpRampProviderStages,
} from "@sdp/types";
import { RAMP_PROVIDERS } from "@sdp/types";
import { getDb } from "@/db/client";
import {
  createPostgresRampWebhookEventsRepository,
  type RampWebhookEventRow,
} from "@/db/repositories/ramp-webhook-event.repository";
import { AppError } from "@/lib/errors";
import { isRampProviderAvailable } from "@/lib/feature-flags";
import { logEvent, paymentsErrorDiagnostics } from "@/runtime/money-path-events";
import {
  TerminalRampWebhookError,
  type WebhookProcessor,
} from "@/services/ramps/webhooks/processor";
import {
  isWebhookRampProvider,
  RAMP_PROVIDER_WEBHOOK_PROCESSOR,
} from "@/services/ramps/webhooks/registry";
import type { Env } from "@/types/env";

/**
 * A provider sends a settlement webhook exactly once (plus its own bounded
 * retries), so every verified event is persisted BEFORE the 200 ack and only
 * discharged after `process` finishes. This module is both halves of that
 * contract: the apply used by the request's background pass, and the replay
 * that picks up whatever a crashed or failed background pass left behind.
 *
 * Applying is idempotent — the settlement path guards every status write with
 * a compare-and-swap — so replaying an event that half-applied is safe.
 */

/** After this many failed applies the row parks as `failed` and pages. */
export const RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS = 10;

/** Rows younger than this are the in-request background pass's to apply. */
export const RAMP_WEBHOOK_EVENT_REPLAY_MIN_AGE_MS = 2 * 60 * 1000;

export const RAMP_WEBHOOK_EVENT_REPLAY_BATCH = 50;

export const RAMP_WEBHOOK_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const RAMP_WEBHOOK_EVENT_EXHAUSTED_EVENT = "sdp_api_ramp_webhook_event_exhausted";

export const RAMP_WEBHOOK_EVENT_DISCARDED_EVENT = "sdp_api_ramp_webhook_event_discarded";

class InvalidRampWebhookError extends TerminalRampWebhookError {}

type RampWebhookFailureKind = "invalid" | "terminal" | "retryable";

function classifyFailure(error: unknown): RampWebhookFailureKind {
  if (error instanceof InvalidRampWebhookError) {
    return "invalid";
  }
  if (error instanceof TerminalRampWebhookError) {
    return "terminal";
  }
  return "retryable";
}

function failureOutcome(kind: RampWebhookFailureKind): RampWebhookFailureOutcome {
  switch (kind) {
    case "invalid":
      return "invalid";
    case "terminal":
      return "refused";
    case "retryable":
      return "retryable_error";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function businessFailureReason(result: RampWebhookProcessResult): string {
  return result.outcome === "refused" ? result.reason : `provider event ${result.outcome}`;
}

/**
 * The identity a parked row is stamped with; a later deploy changes it.
 * Deliberately the image build SHA, NOT K_REVISION and not API_VERSION: the
 * api service parks rows (background apply) and the worker re-arms them, and
 * Cloud Run gives every service its own revision name, while API_VERSION is
 * static configuration that deploys do not bump. Both services deploy from
 * the same image, so its build SHA is shared by the two sides and moves
 * exactly when a deploy ships. A runtime without one (local, compose) uses a
 * fixed placeholder: no deploys happen there, so nothing re-arms.
 */
function currentAppRevision(env: Env): string {
  const sha = env.SDP_BUILD_SHA?.trim();
  return sha ? sha : "local";
}

/**
 * Applies one persisted event and discharges its row. On failure the row
 * keeps its payload and error for the next replay pass, or parks as `failed`
 * once attempts are exhausted — the alertable state, because it means a
 * provider told SDP about a settlement and SDP could not act on it.
 *
 * @param attempts - Attempts spent including the one this call is making.
 */
export async function applyStoredRampWebhookEvent(
  env: Env,
  row: RampWebhookEventRow,
  attempts: number
): Promise<boolean> {
  const events = createPostgresRampWebhookEventsRepository(getDb(env));
  if (!isWebhookRampProvider(row.provider)) {
    // Unreachable while inserts come from the registry; a row from a retired
    // provider parks immediately rather than burning replay attempts. NOT
    // terminal: a later release can restore the processor, and the deploy
    // re-arm should hand the row to it.
    await events.recordFailure({
      id: row.id,
      error: `no webhook processor for provider ${row.provider}`,
      attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      appRevision: currentAppRevision(env),
    });
    return false;
  }
  const processor: WebhookProcessor<unknown> = RAMP_PROVIDER_WEBHOOK_PROCESSOR[row.provider];
  try {
    let parsed: unknown;
    try {
      parsed = processor.parse(row.rawBody, row.environment);
    } catch (error) {
      if (error instanceof AppError && error.code === "BAD_REQUEST") {
        if (row.environment === "sandbox") {
          await events.dischargeEvent(row.id, "discarded", error.message);
          logEvent("warn", {
            event: RAMP_WEBHOOK_EVENT_DISCARDED_EVENT,
            flow: "ramp-settlement",
            webhook_event_id: row.id,
            provider: row.provider,
            environment: row.environment,
            outcome: "invalid",
          });
          return false;
        }
        throw new InvalidRampWebhookError(error.message);
      }
      throw error;
    }

    const result = await processor.process(env, row.environment, parsed);
    const { outcome, reason } = result;
    if (outcome === "unmatched" || outcome === "refused") {
      if (row.environment === "sandbox") {
        await events.dischargeEvent(row.id, "discarded", businessFailureReason(result));
        logEvent("warn", {
          event: RAMP_WEBHOOK_EVENT_DISCARDED_EVENT,
          flow: "ramp-settlement",
          webhook_event_id: row.id,
          provider: row.provider,
          environment: row.environment,
          outcome,
          reason,
        });
        return false;
      }
      const terminal = outcome === "refused";
      const spentAttempts = terminal ? RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS : attempts;
      await events.recordFailure({
        id: row.id,
        error: businessFailureReason(result),
        attempts: spentAttempts,
        maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
        appRevision: currentAppRevision(env),
        terminal,
        outcome,
      });
      if (spentAttempts >= RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS) {
        logEvent("error", {
          event: RAMP_WEBHOOK_EVENT_EXHAUSTED_EVENT,
          flow: "ramp-settlement",
          webhook_event_id: row.id,
          provider: row.provider,
          environment: row.environment,
          outcome,
          reason,
          attempts: spentAttempts,
        });
      }
      return false;
    }
    await events.dischargeEvent(row.id, outcome === "ignored" ? "ignored" : "applied");
    return outcome !== "ignored";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureKind = classifyFailure(error);
    if (row.environment === "sandbox" && failureKind === "terminal") {
      await events.dischargeEvent(row.id, "discarded", message);
      logEvent("warn", {
        event: RAMP_WEBHOOK_EVENT_DISCARDED_EVENT,
        flow: "ramp-settlement",
        webhook_event_id: row.id,
        provider: row.provider,
        environment: row.environment,
        outcome: "refused",
      });
      return false;
    }
    const terminal = failureKind !== "retryable";
    const spentAttempts = terminal ? RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS : attempts;
    await events.recordFailure({
      id: row.id,
      error: message,
      attempts: spentAttempts,
      maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      appRevision: currentAppRevision(env),
      terminal,
      outcome: failureOutcome(failureKind),
    });
    if (spentAttempts >= RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS) {
      logEvent("error", {
        event: RAMP_WEBHOOK_EVENT_EXHAUSTED_EVENT,
        flow: "ramp-settlement",
        webhook_event_id: row.id,
        provider: row.provider,
        environment: row.environment,
        attempts: spentAttempts,
        error: message,
        error_diagnostics: paymentsErrorDiagnostics(error),
      });
    }
    return false;
  }
}

/**
 * Replays pending events the background pass failed to apply (or never got to
 * run for — a deploy or crash between the ack and the apply). Returns the
 * number of events applied.
 *
 * Rows from a ramp provider the release channel leaves out are never re-armed,
 * parked or replayed: they stay exactly as they are until the provider returns.
 *
 * @param rampProviderStages - `SDP_RAMP_PROVIDER_STAGES`; tests may pass their own.
 */
export async function replayRampWebhookEvents(
  env: Env,
  rampProviderStages: SdpRampProviderStages
): Promise<number> {
  const events = createPostgresRampWebhookEventsRepository(getDb(env));
  await events.archiveDischarged(
    new Date(Date.now() - RAMP_WEBHOOK_EVENT_RETENTION_MS).toISOString(),
    100
  );
  const excludedProviders = RAMP_PROVIDERS.filter(
    (provider) => !isRampProviderAvailable(env, provider, rampProviderStages)
  );
  if (excludedProviders.length === RAMP_PROVIDERS.length) {
    return 0;
  }
  const cutoff = new Date(Date.now() - RAMP_WEBHOOK_EVENT_REPLAY_MIN_AGE_MS).toISOString();
  const appRevision = currentAppRevision(env);

  // A deploy may carry the fix a parked row was waiting for: rows parked by a
  // different revision go back to pending with fresh attempts, so the happy
  // path after an incident is "ship the fix" with no manual re-arm. Rows the
  // CURRENT revision parked stay parked — same code, same payload, same
  // outcome.
  for (const row of await events.rearmParkedByOtherRevisions({ appRevision, excludedProviders })) {
    logEvent("info", {
      event: "sdp_api_ramp_webhook_event_rearmed",
      flow: "ramp-settlement",
      webhook_event_id: row.id,
      provider: row.provider,
      environment: row.environment,
      app_revision: appRevision,
    });
  }

  // A crash after the final claim leaves a pending row every claim excludes:
  // park it as failed and page, instead of stranding it silently.
  for (const row of await events.parkExhausted({
    updatedBefore: cutoff,
    maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
    appRevision,
    excludedProviders,
  })) {
    logEvent("error", {
      event: RAMP_WEBHOOK_EVENT_EXHAUSTED_EVENT,
      flow: "ramp-settlement",
      webhook_event_id: row.id,
      provider: row.provider,
      environment: row.environment,
      attempts: row.attempts,
      error: row.last_error,
    });
  }

  // One claim per row, taken right before its apply: a batch-wide claim would
  // start every lease at once and let a slow early row expire the later ones.
  let applied = 0;
  let claimed = 0;
  while (claimed < RAMP_WEBHOOK_EVENT_REPLAY_BATCH) {
    const [row] = await events.claimReplayable({
      createdBefore: cutoff,
      maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      limit: 1,
      excludedProviders,
    });
    if (!row) {
      break;
    }
    claimed += 1;
    // `claimReplayable` already spent this attempt.
    if (await applyStoredRampWebhookEvent(env, row, row.attempts)) {
      applied += 1;
    }
  }
  if (claimed > 0) {
    logEvent("info", {
      event: "sdp_api_ramp_webhook_events_replayed",
      flow: "ramp-settlement",
      claimed,
      applied,
    });
  }
  return applied;
}
