import { CUSTODY_PROVIDER_CATALOG, type ProviderMode } from "@sdp/types/custody";
import type {
  CustodyIntegration,
  IntegrationFamily,
  ProjectIntegrations,
} from "@sdp/types/integrations";
import type {
  ProjectProviderAvailability,
  ProjectProviderAvailabilityEntry,
} from "@sdp/types/provider-access";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";
import {
  getProjectProviderAvailability,
  type ProjectProviderScope,
} from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

interface ActiveCustodyRecordRow {
  provider: string;
  mode: ProviderMode;
}

interface ProjectIntegrationFacts {
  availability: ProjectProviderAvailability;
  activeCustodyModes: ReadonlyMap<string, ReadonlySet<ProviderMode>>;
}

/**
 * A project's integrations, decided from one consistent snapshot of its
 * provider availability and setup records, so a setup that changes records
 * mid-read is never reported as neither.
 *
 * @param env - Process environment naming the release channel and provider credentials.
 * @param db - Database client; the read runs in its own read-only transaction.
 * @param scope - The project the read is for.
 * @param isInChannel - Whether the deployment's release channel runs an availability entry's provider.
 * @returns The project's integrations by family; absent families have no usable provider.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function getProjectIntegrations(
  env: Env,
  db: DatabaseClient,
  scope: ProjectProviderScope,
  isInChannel: (entry: ProjectProviderAvailabilityEntry) => boolean
): Promise<ProjectIntegrations> {
  const facts = await db.transaction(async (tx): Promise<ProjectIntegrationFacts> => {
    await tx.queryMany("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const availability = await getProjectProviderAvailability(env, tx, scope);
    const activeCustodyModes = await loadActiveCustodyModes(tx, scope);
    return { availability, activeCustodyModes };
  });

  const families: IntegrationFamily[] = [];
  const custody = custodyIntegrations(facts, isInChannel);
  if (custody.length > 0) families.push({ family: "custody", integrations: custody });

  return {
    projectId: facts.availability.projectId,
    environment: facts.availability.environment,
    families,
  };
}

async function loadActiveCustodyModes(
  db: DatabaseExecutor,
  scope: ProjectProviderScope
): Promise<Map<string, Set<ProviderMode>>> {
  const rows = await db.queryMany<ActiveCustodyRecordRow>(
    `SELECT provider, 'managed' AS mode
       FROM custody_configs
      WHERE organization_id = ?
        AND project_id = ?
        AND status = 'active'
     UNION
     SELECT provider, 'byok' AS mode
       FROM custody_connections
      WHERE organization_id = ?
        AND project_id = ?
        AND status = 'active'`,
    [scope.organizationId, scope.projectId, scope.organizationId, scope.projectId]
  );
  const modesByProvider = new Map<string, Set<ProviderMode>>();
  for (const row of rows) {
    const modes = modesByProvider.get(row.provider) ?? new Set<ProviderMode>();
    modes.add(row.mode);
    modesByProvider.set(row.provider, modes);
  }
  return modesByProvider;
}

function custodyIntegrations(
  facts: ProjectIntegrationFacts,
  isInChannel: (entry: ProjectProviderAvailabilityEntry) => boolean
): CustodyIntegration[] {
  const entries = new Map(
    facts.availability.providers.flatMap((entry) =>
      entry.family === "custody" && isInChannel(entry) ? [[entry.provider, entry] as const] : []
    )
  );
  return CUSTODY_PROVIDER_CATALOG.flatMap((catalogEntry): CustodyIntegration[] => {
    const entry = entries.get(catalogEntry.id);
    if (!catalogEntry.visible || entry === undefined) return [];
    const activeModes = facts.activeCustodyModes.get(catalogEntry.id);
    // A project's own account is the stronger statement of setup, so BYOK wins
    // when the project holds both records.
    if (activeModes?.has("byok")) {
      return [
        {
          provider: catalogEntry.id,
          category: catalogEntry.category,
          state: { status: "connected", mode: "byok" },
        },
      ];
    }
    if (activeModes?.has("managed")) {
      return [
        {
          provider: catalogEntry.id,
          category: catalogEntry.category,
          state: { status: "connected", mode: "managed" },
        },
      ];
    }
    const [firstMode, ...otherModes] = entry.modes;
    if (firstMode === undefined) return [];
    return [
      {
        provider: catalogEntry.id,
        category: catalogEntry.category,
        state: { status: "not_configured", modes: [firstMode, ...otherModes] },
      },
    ];
  });
}
