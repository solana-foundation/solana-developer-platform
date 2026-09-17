/**
 * BVNK on-ramp quote expiry entrypoint.
 *
 * An `awaiting_payment` on-ramp transfer is an abandoned quote after the
 * 24-hour TTL: the transfer is expired by a status-guarded UPDATE (the status
 * in the WHERE is the CAS), then every expired transfer still holding a
 * non-deactivated payment rule has that rule deactivated. A failed
 * deactivation is logged and left for the next tick: the ruleStatus filter
 * keeps matching until the deactivation lands, and the stray-rule sweep at
 * the next quote is the backstop for rules that never deactivate.
 *
 * Wraps `reconcileBvnkOnrampExpiry` with a Sentry cron monitor when
 * observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so the Node background runner keeps it alive past the
 * initiating tick and drains it during graceful shutdown.
 */

import { readRecord } from "@sdp/payments/json";
import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { BVNK_ONRAMP_QUOTE_TTL_HOURS, type SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { getLogger } from "@/runtime/logger";
import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

export const BVNK_ONRAMP_EXPIRY_MONITOR = "sdp-api-bvnk-onramp-expiry";
export const BVNK_ONRAMP_EXPIRY_CRON = "*/15 * * * *";

interface ExpiredBvnkOnrampTransferRow {
  id: string;
  provider_data: Record<string, unknown>;
}

/** A deployment configures exactly one BVNK credential set; its presence picks the ramp environment. */
function resolveBvnkCronEnvironment(env: Env): SdpEnvironment {
  return env.BVNK_SANDBOX_HAWK_AUTH_ID?.trim() ? "sandbox" : "production";
}

function bvnkCronRuntimeContext(env: Env): RampRuntimeContext {
  return {
    env: env as unknown as Record<string, string | undefined>,
    mode: resolveBvnkCronEnvironment(env),
  };
}

/**
 * Expires abandoned BVNK on-ramp quotes and deactivates their payment rules.
 * The expiration UPDATE matches only rows still `awaiting_payment`, so a
 * transfer that settled or completed concurrently keeps its status; the
 * deactivation pass covers every expired row whose rule is not yet marked
 * DEACTIVATED, so a failed deactivation is retried on the next tick.
 *
 * @param env - Process environment used for database and provider access.
 * @returns Resolves once the expiry and deactivation pass complete.
 */
export async function reconcileBvnkOnrampExpiry(env: Env): Promise<void> {
  await getDb(env)
    .prepare(
      `UPDATE payment_transfers
       SET status = 'expired',
           updated_at = sdp_iso_now()
       WHERE provider = 'bvnk'
         AND direction = 'onramp'
         AND status = 'awaiting_payment'
         AND created_at < now() - make_interval(hours => ?)`
    )
    .bind(BVNK_ONRAMP_QUOTE_TTL_HOURS)
    .run();

  const expired = await getDb(env)
    .prepare(
      `SELECT id, provider_data
       FROM payment_transfers
       WHERE provider = 'bvnk'
         AND direction = 'onramp'
         AND status = 'expired'
         AND provider_data->'bvnk'->>'ruleId' IS NOT NULL
         AND provider_data->'bvnk'->>'ruleStatus' IS DISTINCT FROM 'DEACTIVATED'
       ORDER BY created_at ASC
       LIMIT 1000`
    )
    .all<ExpiredBvnkOnrampTransferRow>();

  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const ctx = bvnkCronRuntimeContext(env);
  for (const transfer of expired.results) {
    const bvnk = readRecord(transfer.provider_data.bvnk) ?? {};
    const ruleId = typeof bvnk.ruleId === "string" ? bvnk.ruleId : undefined;
    if (ruleId === undefined || ruleId === "") {
      continue;
    }
    try {
      await client.deactivateOnrampRule(ctx, { ruleId });
    } catch (error) {
      getLogger().error(
        `sdp_api_bvnk_rule_deactivate_failed rule=${ruleId} transfer=${transfer.id} error=${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    await getDb(env)
      .prepare(
        `UPDATE payment_transfers
         SET provider_data = jsonb_set(
               provider_data,
               '{bvnk,ruleStatus}',
               '"DEACTIVATED"',
               true
             ),
             updated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(transfer.id)
      .run();
  }
}

export interface BvnkOnrampExpiryDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runBvnkOnrampExpiryReconciliation(deps: BvnkOnrampExpiryDeps): void {
  const work = () => reconcileBvnkOnrampExpiry(deps.env);

  // Never invoke `work` eagerly: a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(BVNK_ONRAMP_EXPIRY_MONITOR, work, {
        schedule: { type: "crontab", value: BVNK_ONRAMP_EXPIRY_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
