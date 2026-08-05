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

function resolveTargetType(input: {
  hasActiveConnection: boolean;
  hasLegacyConfig: boolean;
}): CustodyEffectiveTargetType {
  // A Connection is the newer target and wins when both exist, which is the
  // state a migrated provider passes through.
  if (input.hasActiveConnection) {
    return "connection";
  }
  return input.hasLegacyConfig ? "config" : "none";
}

/**
 * Reports what is actually installed per custody provider for a scope.
 *
 * Deliberately reads nothing but existing rows: environment credentials make a
 * provider *installable*, and reporting them as installed is what made the setup
 * step unable to tell "ready to connect" from "already connected". This must stay
 * side-effect free — it creates no Config, Credential, Connection or wallet.
 */
export async function getCustodySetupStatus(
  db: DatabaseClient,
  organizationId: string,
  projectId: string | undefined
): Promise<CustodySetupStatusResponse> {
  // Branch the predicate rather than comparing a bare placeholder to NULL:
  // Postgres cannot infer a type for `? IS NULL` and rejects the statement.
  const projectPredicate = projectId ? "AND project_id = ?" : "AND project_id IS NULL";
  const scopeParams = projectId ? [organizationId, projectId] : [organizationId];

  const [connectionRows, configRows] = await Promise.all([
    db.queryMany<ProviderCountRow>(
      `SELECT provider, status, COUNT(*) AS total
         FROM custody_connections
        WHERE organization_id = ?
          ${projectPredicate}
        GROUP BY provider, status`,
      scopeParams
    ),
    db.queryMany<ProviderFlagRow>(
      `SELECT DISTINCT provider
         FROM custody_configs
        WHERE organization_id = ?
          ${projectPredicate}
          AND status = 'active'`,
      scopeParams
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
      effectiveTargetType: resolveTargetType({
        hasActiveConnection: connectionCounts.active > 0,
        hasLegacyConfig,
      }),
      connectionCounts,
    };
  });

  return { providers };
}
