import { getDb } from "@/db";
import {
  createPostgresRampWebhookEventsRepository,
  type RampWebhookEventRow,
} from "@/db/repositories/ramp-webhook-event.repository";
import {
  TerminalRampWebhookError,
  type WebhookProcessor,
} from "@/routes/webhooks/ramps/processor";
import {
  isWebhookRampProvider,
  RAMP_PROVIDER_WEBHOOK_PROCESSOR,
} from "@/routes/webhooks/ramps/registry";
import { logEvent } from "@/runtime/money-path-events";
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

export const RAMP_WEBHOOK_EVENT_EXHAUSTED_EVENT = "sdp_api_ramp_webhook_event_exhausted";

export const RAMP_WEBHOOK_EVENT_DISCARDED_EVENT = "sdp_api_ramp_webhook_event_discarded";

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
    // provider parks immediately rather than burning replay attempts.
    await events.recordFailure({
      id: row.id,
      error: `no webhook processor for provider ${row.provider}`,
      attempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
      maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
    });
    return false;
  }
  const processor: WebhookProcessor<unknown, unknown> =
    RAMP_PROVIDER_WEBHOOK_PROCESSOR[row.provider];
  try {
    await processor.process(env, row.environment, processor.parse(row.payload));
    await events.deleteEvent(row.id);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = error instanceof TerminalRampWebhookError;
    if (terminal && row.environment === "sandbox") {
      await events.deleteEvent(row.id);
      logEvent("warn", {
        event: RAMP_WEBHOOK_EVENT_DISCARDED_EVENT,
        flow: "ramp-settlement",
        webhook_event_id: row.id,
        provider: row.provider,
        environment: row.environment,
        attempts,
        error: message,
      });
      return false;
    }
    const spentAttempts = terminal ? RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS : attempts;
    await events.recordFailure({
      id: row.id,
      error: message,
      attempts: spentAttempts,
      maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
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
      });
    }
    return false;
  }
}

/**
 * Replays pending events the background pass failed to apply (or never got to
 * run for — a deploy or crash between the ack and the apply). Returns the
 * number of events applied.
 */
export async function replayRampWebhookEvents(env: Env): Promise<number> {
  const events = createPostgresRampWebhookEventsRepository(getDb(env));
  const cutoff = new Date(Date.now() - RAMP_WEBHOOK_EVENT_REPLAY_MIN_AGE_MS).toISOString();

  // A crash after the final claim leaves a pending row every claim excludes:
  // park it as failed and page, instead of stranding it silently.
  for (const row of await events.parkExhausted({
    updatedBefore: cutoff,
    maxAttempts: RAMP_WEBHOOK_EVENT_MAX_ATTEMPTS,
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
