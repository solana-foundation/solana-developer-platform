import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { bvnkOnrampTransferProviderDataSchema } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { BVNK_ONRAMP_QUOTE_TTL_HOURS, type SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { createSystemPaymentsRepository } from "@/db/repositories";
import type { CounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { internalError } from "@/lib/errors";
import { resolveBvnkOnrampRule } from "@/routes/payments/handlers/ramps/bvnk";
import type { BackgroundRunner } from "@/runtime/background";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

export const BVNK_ONRAMP_EXPIRY_MONITOR = "sdp-api-bvnk-onramp-expiry";
export const BVNK_ONRAMP_EXPIRY_CRON = "*/15 * * * *";

interface ExpiredBvnkOnrampTransferRow {
  id: string;
  organization_id: string;
  project_id: string;
  counterparty_id: string;
  fiat_currency: string;
  provider_data: Record<string, unknown>;
}

/**
 * Resolves the BVNK ledger wallet id backing an expired transfer's funding
 * wallet row, needed to list and deactivate its payment rule.
 *
 * @param accounts - Provider-account repository used for the row lookup.
 * @param transfer - The expired on-ramp transfer row.
 * @returns The BVNK wallet id bound to the transfer's funding wallet.
 */
async function walletIdForTransfer(
  accounts: CounterpartyProviderAccountsRepository,
  transfer: ExpiredBvnkOnrampTransferRow
): Promise<string> {
  const row = await accounts.getVirtualFundingWallet({
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    counterpartyId: transfer.counterparty_id,
    provider: "bvnk",
    fiatCurrency: transfer.fiat_currency,
  });
  if (row === null || row.external_account_reference === null) {
    throw internalError(
      `BVNK on-ramp transfer ${transfer.id} has no bound funding wallet for its rule.`
    );
  }
  return row.external_account_reference;
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
 * Expires abandoned BVNK on-ramp quotes past the 24-hour TTL and deactivates
 * their payment rules. The expiration UPDATE matches only rows still
 * `awaiting_payment`, so a transfer that settled or completed concurrently
 * keeps its status; each expired row's rule is resolved first (adopting a
 * rule a crash left bound at BVNK but not on the row) and then deactivated,
 * unless already marked DEACTIVATED, so a failed deactivation is retried on
 * the next tick.
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
        AND type = 'onramp'
        AND status = 'awaiting_payment'
        AND created_at::timestamptz < now() - make_interval(hours => ?)`
    )
    .bind(BVNK_ONRAMP_QUOTE_TTL_HOURS)
    .run();

  const expired = await getDb(env)
    .prepare(
      `SELECT id, organization_id, project_id, counterparty_id, fiat_currency, provider_data
       FROM payment_transfers
       WHERE provider = 'bvnk'
         AND type = 'onramp'
         AND status = 'expired'
         AND provider_data->'bvnk'->>'ruleStatus' IS DISTINCT FROM 'DEACTIVATED'
       ORDER BY created_at ASC
       LIMIT 1000`
    )
    .all<ExpiredBvnkOnrampTransferRow>();

  const client = RAMP_PROVIDER_CLIENTS.bvnk;
  const ctx = bvnkCronRuntimeContext(env);
  const payments = createSystemPaymentsRepository(env);
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  for (const transfer of expired.results) {
    const bvnk = bvnkOnrampTransferProviderDataSchema.parse(transfer.provider_data).bvnk;
    let ruleId = bvnk.ruleId;
    if (ruleId === undefined) {
      const rule = await resolveBvnkOnrampRule(
        payments,
        ctx,
        transfer,
        await walletIdForTransfer(accounts, transfer),
        null
      );
      if (rule === null) {
        continue;
      }
      ruleId = rule.ruleId;
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
    await payments.markBvnkOnrampRuleDeactivated({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      updatedAt: new Date().toISOString(),
    });
  }
}

export interface BvnkOnrampExpiryDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

/**
 * Wraps `reconcileBvnkOnrampExpiry` with a Sentry cron monitor when
 * observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so the Node background runner keeps it alive past the
 * initiating tick and drains it during graceful shutdown.
 *
 * @param deps - Environment, background runner, and optional observability.
 * @returns Nothing; the work promise is owned by the background runner.
 */
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
