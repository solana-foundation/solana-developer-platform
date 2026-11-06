import { configuredManagedRpcProviders } from "@sdp/rpc/factory";
import { CUSTODY_PROVIDER_CATALOG, type ProviderMode } from "@sdp/types/custody";
import type {
  ComplianceIntegration,
  CustodyIntegration,
  IntegrationFamily,
  ProjectIntegrations,
  RampIntegration,
  RpcIntegration,
} from "@sdp/types/integrations";
import type {
  ProjectProviderAvailability,
  ProjectProviderAvailabilityEntry,
} from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { asTransactionalClient, type DatabaseClient, type DatabaseExecutor } from "@/db/client";
import { createPostgresPrivateChannelInstanceRepository } from "@/db/repositories/private-channel-instance.repository.postgres";
import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
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
  privateChannelsActive: boolean | null;
}

/**
 * A project's integrations, decided from one consistent snapshot of its
 * provider availability and setup records, so a setup that changes records
 * mid-read is never reported as neither.
 *
 * @param env - Process environment naming the release channel and provider credentials.
 * @param db - Database client; the read runs in its own read-only transaction.
 * @param scope - The project the read is for.
 * @param isProviderInChannel - Whether the deployment's release channel runs an availability entry's provider.
 * @returns The project's integrations by family; absent families have no usable provider.
 * @throws 404 when the project is not an active project of the organization.
 */
export async function getProjectIntegrations(
  env: Env,
  db: DatabaseClient,
  scope: ProjectProviderScope,
  isProviderInChannel: (entry: ProjectProviderAvailabilityEntry) => boolean
): Promise<ProjectIntegrations> {
  const privateChannelsEnabled = isPrivateChannelsEnabled(env);
  const facts = await db.transaction(async (tx): Promise<ProjectIntegrationFacts> => {
    await tx.queryMany("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const availability = await getProjectProviderAvailability(env, tx, scope);
    const activeCustodyModes = await loadActiveCustodyModes(tx, scope);
    const privateChannelsActive = privateChannelsEnabled
      ? (await createPostgresPrivateChannelInstanceRepository(
          asTransactionalClient(tx)
        ).getActiveByProject(scope)) !== null
      : null;
    return { availability, activeCustodyModes, privateChannelsActive };
  });

  const families: IntegrationFamily[] = [];
  const custody = custodyIntegrations(facts, isProviderInChannel);
  if (custody.length > 0) families.push({ family: "custody", integrations: custody });
  const rpc = rpcIntegrations(facts);
  if (rpc.length > 0) families.push({ family: "rpc", integrations: rpc });
  const ramps = rampIntegrations(facts, isProviderInChannel);
  if (ramps.length > 0) families.push({ family: "ramps", integrations: ramps });
  const compliance = complianceIntegrations(facts, isProviderInChannel);
  if (compliance.length > 0) families.push({ family: "compliance", integrations: compliance });
  if (facts.privateChannelsActive !== null) {
    families.push({
      family: "private_channels",
      integrations: [
        {
          provider: "private_channels",
          state: facts.privateChannelsActive
            ? { status: "connected", mode: "managed" }
            : { status: "not_configured", modes: ["managed"] },
        },
      ],
    });
  }

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

function rpcIntegrations(facts: ProjectIntegrationFacts): RpcIntegration[] {
  const cluster = CLUSTER_BY_SDP_ENVIRONMENT[facts.availability.environment];
  // Failover order, so the first row is the provider the pool tries first.
  return configuredManagedRpcProviders(cluster).flatMap((provider): RpcIntegration[] =>
    provider === "default" ? [] : [{ provider, state: { status: "provided", modes: [] } }]
  );
}

function rampIntegrations(
  facts: ProjectIntegrationFacts,
  isInChannel: (entry: ProjectProviderAvailabilityEntry) => boolean
): RampIntegration[] {
  return facts.availability.providers.flatMap((entry): RampIntegration[] =>
    entry.family === "ramps" && entry.available && isInChannel(entry)
      ? [{ provider: entry.provider, state: { status: "provided", modes: [] } }]
      : []
  );
}

function complianceIntegrations(
  facts: ProjectIntegrationFacts,
  isInChannel: (entry: ProjectProviderAvailabilityEntry) => boolean
): ComplianceIntegration[] {
  return facts.availability.providers.flatMap((entry): ComplianceIntegration[] =>
    entry.family === "compliance" && entry.available && isInChannel(entry)
      ? [{ provider: entry.provider, state: { status: "provided", modes: [] } }]
      : []
  );
}
