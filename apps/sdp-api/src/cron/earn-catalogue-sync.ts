/**
 * Earn strategy-catalogue sync entrypoint.
 *
 * Mirrors `pending-transfers`: wraps the sync with a Sentry cron monitor when
 * observability is supplied, and hands the resulting promise to the
 * BackgroundRunner so it survives past the initiating tick and drains during
 * graceful shutdown. Gated on the Earn feature flag.
 *
 * The sync iterates every registered vault-infra provider per environment,
 * pulls the live strategy catalogue, and upserts it into `earn_strategies`
 * keyed on (provider, provider_reference, environment) — the only writer of
 * that table besides the dev seed. It degrades provider-by-provider: one
 * provider failing (or still being a NOT_IMPLEMENTED stub) must never sink
 * the others' pass.
 */

import { EARN_PROVIDER_CLIENTS, isStrategyWithinDeclaredSupport, SdpEarnError } from "@sdp/earn";
import type {
  EarnRuntimeContext,
  EarnVaultProvider,
  ProviderStrategySnapshot,
} from "@sdp/earn/types";
import type { SdpEnvironment } from "@sdp/types";
import { createEarnRepository, type EarnRepository } from "@/db/repositories";
import type { BackgroundRunner } from "@/runtime/background";
import { getLogger } from "@/runtime/logger";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

export const EARN_CATALOGUE_SYNC_MONITOR = "sdp-api-sync-earn-catalogue";
// Catalogue drift is slow (a provider onboarding or delisting a vault), so
// hourly keeps rows fresh without hammering provider APIs.
export const EARN_CATALOGUE_SYNC_CRON = "0 * * * *";

// The catalogue is platform-global but environment-scoped (sandbox rows carry
// devnet mints, production rows mainnet mints), so each provider syncs once
// per environment.
const SYNCED_ENVIRONMENTS: readonly SdpEnvironment[] = ["sandbox", "production"];

// Expected steady states, not incidents: stub integrations report
// NOT_IMPLEMENTED and environments without credentials report
// PROVIDER_NOT_CONFIGURED. Both skip quietly; anything else logs an error.
const SKIPPABLE_SYNC_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_IMPLEMENTED",
  "PROVIDER_NOT_CONFIGURED",
]);

export async function syncEarnCatalogue(env: Env): Promise<void> {
  const repo = createEarnRepository(env);
  // Providers read their own credentials from the raw env keyed by
  // environment — same contract as the route-layer earnRuntime().
  const providerEnv = env as unknown as Record<string, string | undefined>;

  for (const environment of SYNCED_ENVIRONMENTS) {
    for (const client of Object.values(EARN_PROVIDER_CLIENTS)) {
      await syncProviderCatalogue(repo, client, { env: providerEnv, environment });
    }
  }
}

async function syncProviderCatalogue(
  repo: EarnRepository,
  client: EarnVaultProvider,
  ctx: EarnRuntimeContext
): Promise<void> {
  const logContext = { provider: client.provider, environment: ctx.environment };

  let snapshots: ProviderStrategySnapshot[];
  try {
    snapshots = await client.listStrategies(ctx);
  } catch (err) {
    if (err instanceof SdpEarnError && SKIPPABLE_SYNC_ERROR_CODES.has(err.code)) {
      getLogger().info(
        { ...logContext, code: err.code },
        "syncEarnCatalogue: provider catalogue skipped"
      );
      return;
    }
    getLogger().error(
      { ...logContext, error: err instanceof Error ? err.message : String(err) },
      "syncEarnCatalogue: failed to list provider strategies"
    );
    return;
  }

  for (const snapshot of snapshots) {
    // A snapshot outside the provider's declared support envelope is provider
    // drift (an unvetted deposit mint or an undeclared strategy shape) — flag
    // it and keep it out of the catalogue rather than persist it.
    if (!isStrategyWithinDeclaredSupport(client.declaredSupport, snapshot)) {
      getLogger().warn(
        {
          ...logContext,
          provider_reference: snapshot.providerReference,
          source_kind: snapshot.sourceKind,
          deposit_mints: snapshot.depositMints,
        },
        "syncEarnCatalogue: strategy outside declared support"
      );
      continue;
    }

    try {
      await repo.upsertStrategy({
        provider: client.provider,
        providerReference: snapshot.providerReference,
        name: snapshot.name,
        sourceKind: snapshot.sourceKind,
        underlyingSource: snapshot.underlyingSource ?? null,
        depositMints: snapshot.depositMints,
        shareMint: snapshot.shareMint ?? null,
        apyType: snapshot.apyType,
        currentApy: snapshot.currentApy ?? null,
        liquidityTerm: snapshot.liquidityTerm,
        redemptionDelayDays: snapshot.redemptionDelayDays ?? null,
        riskMetadata: snapshot.riskMetadata ?? {},
        // Providers report no status; being listed is what makes a strategy
        // depositable, so every pass re-asserts `active`. A hand-paused row
        // therefore only stays paused while the provider stops listing its
        // reference — delisting is the durable way off the depositable set.
        status: "active",
        environment: ctx.environment,
      });
    } catch (err) {
      getLogger().error(
        {
          ...logContext,
          provider_reference: snapshot.providerReference,
          error: err instanceof Error ? err.message : String(err),
        },
        "syncEarnCatalogue: failed to upsert strategy"
      );
    }
  }
}

export interface EarnCatalogueSyncDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runEarnCatalogueSync(deps: EarnCatalogueSyncDeps): void {
  const work = () => syncEarnCatalogue(deps.env);

  // Never invoke `work` eagerly — a sync throw before the first await must become
  // a rejected promise the BackgroundRunner can track, not propagate to the
  // runtime entrypoint.
  const promise = deps.observability
    ? deps.observability.withMonitor(EARN_CATALOGUE_SYNC_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_CATALOGUE_SYNC_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
