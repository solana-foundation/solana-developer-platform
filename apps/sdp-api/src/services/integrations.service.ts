import { configuredManagedRpcProviders } from "@sdp/rpc/factory";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProvider,
  type ProviderMode,
} from "@sdp/types/custody";
import type {
  ComplianceIntegration,
  CustodyIntegration,
  IntegrationFamily,
  IntegrationState,
  PrivateChannelsIntegration,
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
  provider: CustodyProvider;
  mode: ProviderMode;
}

interface ProjectIntegrationFacts {
  availability: ProjectProviderAvailability;
  activeCustodyModes: ReadonlyMap<CustodyProvider, ReadonlySet<ProviderMode>>;
  privateChannelsActive: boolean | null;
}

/**
 * A project's integrations, decided from one consistent snapshot of its
 * provider availability and setup records, so a setup that changes records
 * mid-read is never reported as neither. Every state follows the rule that
 * admits the provider's use, so a listed integration is never refused for
 * availability at its entry point.
 *
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

  const families: IntegrationFamily[] = [
    { family: "custody", integrations: custodyIntegrations(facts, isProviderInChannel) },
    { family: "rpc", integrations: rpcIntegrations(facts) },
    { family: "ramps", integrations: rampIntegrations(facts, isProviderInChannel) },
    { family: "compliance", integrations: complianceIntegrations(facts, isProviderInChannel) },
    { family: "private_channels", integrations: privateChannelsIntegrations(facts) },
  ];

  return {
    projectId: facts.availability.projectId,
    environment: facts.availability.environment,
    families: families.filter((family) => family.integrations.length > 0),
  };
}

async function loadActiveCustodyModes(
  db: DatabaseExecutor,
  scope: ProjectProviderScope
): Promise<Map<CustodyProvider, Set<ProviderMode>>> {
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
  const modesByProvider = new Map<CustodyProvider, Set<ProviderMode>>();
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
    const state = custodyState(entry.modes, facts.activeCustodyModes.get(catalogEntry.id));
    return state === null
      ? []
      : [{ provider: catalogEntry.id, category: catalogEntry.category, state }];
  });
}

/**
 * Connected only while the project may still use the mode its record runs in;
 * a project's own account is the stronger statement of setup, so BYOK wins when
 * the project holds both records.
 */
function custodyState(
  admittedModes: readonly ProviderMode[],
  activeModes: ReadonlySet<ProviderMode> | undefined
): IntegrationState | null {
  const connectedMode = (["byok", "managed"] as const).find(
    (mode) => activeModes?.has(mode) && admittedModes.includes(mode)
  );
  if (connectedMode !== undefined) return { status: "connected", mode: connectedMode };
  return admittedModes.length > 0 ? { status: "not_configured", modes: [...admittedModes] } : null;
}

function privateChannelsIntegrations(facts: ProjectIntegrationFacts): PrivateChannelsIntegration[] {
  if (facts.privateChannelsActive === null) return [];
  return [
    {
      provider: "private_channels",
      state: facts.privateChannelsActive
        ? { status: "connected", mode: "managed" }
        : { status: "not_configured", modes: ["managed"] },
    },
  ];
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
