import {
  CUSTODY_CONNECTION_LIFECYCLES,
  CUSTODY_PROVIDERS,
  type CustodyConnectionLifecycle,
  type CustodyEffectiveTargetType,
  type CustodyProvider,
  type CustodyProviderSetupStatus,
  type CustodySetupStatusResponse,
} from "@sdp/types";
import type { DatabaseClient } from "@/db";

interface ProviderCountRow {
  provider: string;
  status: string;
  total: number | string;
}

interface ProviderFlagRow {
  provider: string;
}

function emptyCounts(): Record<CustodyConnectionLifecycle, number> {
  return Object.fromEntries(CUSTODY_CONNECTION_LIFECYCLES.map((status) => [status, 0])) as Record<
    CustodyConnectionLifecycle,
    number
  >;
}

function isLifecycle(value: string): value is CustodyConnectionLifecycle {
  return (CUSTODY_CONNECTION_LIFECYCLES as readonly string[]).includes(value);
}

function isKnownProvider(value: string): value is CustodyProvider {
  return (CUSTODY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * What actually backs signing right now — not what has been set up.
 *
 * Per provider, not per scope: `config` means "operations that target this
 * provider resolve through its config" (`getConfigurationByProvider`), so a
 * scope with several active configs reports `config` for each of them. There is
 * no default provider to report: every operation names its custody wallet.
 *
 * An active Connection deliberately does NOT make this `connection`: signing
 * resolves exclusively through custody configs today (`signing.service.ts` never
 * reads `custody_connections`), so reporting a Connection as the signing target
 * would describe a runtime that does not exist and show a migration that has not
 * happened. `connection` becomes reachable when Connection-backed signing lands.
 * Callers that need to see Connections have `connectionCounts`.
 */
function resolveTargetType(input: { hasLegacyConfig: boolean }): CustodyEffectiveTargetType {
  return input.hasLegacyConfig ? "config" : "none";
}

/**
 * Reports what is actually installed per custody provider for a project.
 *
 * Deliberately reads nothing but existing rows: environment credentials make a
 * provider *installable*, and reporting them as installed is what made the setup
 * step unable to tell "ready to connect" from "already connected". This must stay
 * side-effect free — it creates no Config, Credential, Connection or wallet.
 */
export async function getCustodySetupStatus(
  db: DatabaseClient,
  organizationId: string,
  projectId: string
): Promise<CustodySetupStatusResponse> {
  const [connectionRows, configRows] = await Promise.all([
    db.queryMany<ProviderCountRow>(
      `SELECT provider, status, COUNT(*) AS total
         FROM custody_connections
        WHERE organization_id = ?
          AND project_id = ?
        GROUP BY provider, status`,
      [organizationId, projectId]
    ),
    db.queryMany<ProviderFlagRow>(
      `SELECT DISTINCT provider
         FROM custody_configs
        WHERE organization_id = ?
          AND project_id = ?
          AND status = 'active'`,
      [organizationId, projectId]
    ),
  ]);

  const countsByProvider = new Map<CustodyProvider, Record<CustodyConnectionLifecycle, number>>();
  for (const row of connectionRows) {
    if (!isKnownProvider(row.provider) || !isLifecycle(row.status)) {
      continue;
    }
    const counts = countsByProvider.get(row.provider) ?? emptyCounts();
    counts[row.status] = Number(row.total);
    countsByProvider.set(row.provider, counts);
  }

  const legacyProviders = new Set(configRows.map((row) => row.provider).filter(isKnownProvider));

  const providers: CustodyProviderSetupStatus[] = CUSTODY_PROVIDERS.map((provider) => {
    const connectionCounts = countsByProvider.get(provider) ?? emptyCounts();
    const hasLegacyConfig = legacyProviders.has(provider);

    return {
      provider,
      hasLegacyConfig,
      effectiveTargetType: resolveTargetType({ hasLegacyConfig }),
      connectionCounts,
    };
  });

  return { providers };
}
