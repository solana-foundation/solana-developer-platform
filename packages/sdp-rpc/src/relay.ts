import {
  normalizeOrganizationTier,
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
  type OrganizationSettings,
  PROJECT_RPC_PROVIDERS,
  type ProjectRpcProvider,
  type ProjectSettings,
  type ProviderAvailabilityEntry,
  resolveOrganizationProviderEntitlements,
} from "@sdp/types";
import {
  applyApiKeyTemplate,
  withAlchemyApiKey,
  withHeliusApiKey,
  withOptionalApiKeyTemplate,
} from "./config";
import { SdpRpcError } from "./errors";
import type { DatabaseClient, KVStore, KVStoreSet, RpcEnv } from "./types";

export { withHeliusApiKey } from "./config";

export type ManagedRpcProviderId = OrganizationRpcProvider;
export type ResolvedRpcProviderId = ManagedRpcProviderId | "custom";
export type RpcSelectionMode =
  | "project_connection"
  | "organization_connection"
  | "project_provider"
  | "project_custom_provider"
  | "organization_provider"
  | "round_robin_default";

interface ManagedRpcProvider {
  id: ManagedRpcProviderId;
  url: string;
  headers: Record<string, string>;
}

interface RpcProviderStatsRecord {
  requestsTotal: number;
  transactionRequests: number;
  errorsTotal: number;
  latencyTotalMs: number;
  lastRequestAt: string | null;
  lastStatusCode: number | null;
  lastMethod: string | null;
  origins: Record<string, number>;
}

export interface RpcProviderStatsSummary {
  requestsTotal: number;
  transactionRequests: number;
  errorsTotal: number;
  averageLatencyMs: number;
  lastRequestAt: string | null;
  lastStatusCode: number | null;
  lastMethod: string | null;
  origins: Record<string, number>;
}

export interface RpcProviderStatus {
  id: ManagedRpcProviderId;
  endpoint: string;
  stats: RpcProviderStatsSummary;
}

/**
 * What a tenant-owned connection resolves to, as seen from the relay.
 *
 * Deliberately carries no secret: the caller reads the credential through
 * CredentialSecretStore, builds the target, and masks the label before handing
 * it over, so key material never enters this package or anything it logs.
 */
export type TenantRpcConnectionResolution =
  | { kind: "none" }
  /** Configured for this scope but not usable -- must not fall back silently. */
  | { kind: "unusable"; reason: string }
  | {
      kind: "active";
      connectionId: string;
      providerId: ManagedRpcProviderId;
      endpoint: string;
      endpointLabel: string;
      headers: Record<string, string>;
    };

/**
 * Whose credentials an organization's RPC traffic leaves on.
 *
 * `managed` lets platform providers answer when the organization has no live
 * connection of its own. `byok` says it never should.
 */
export type RpcCredentialMode = "managed" | "byok";

export interface TenantRpcConnectionLookup {
  resolve(input: {
    organizationId: string;
    scopeKey: string;
    network: string;
  }): Promise<TenantRpcConnectionResolution>;
  /**
   * Optional so an injected stub can omit it; absent is read as `managed`,
   * which is the behaviour that existed before the mode did.
   */
  credentialMode?(organizationId: string): Promise<RpcCredentialMode>;
}

export interface ResolveRpcTargetInput {
  env: RpcEnv;
  kv: KVStoreSet;
  db: DatabaseClient;
  organizationId: string;
  authProjectId: string | null;
  requestedProjectId: string | null;
  /**
   * Injected rather than imported: CredentialSecretStore lives in the API app,
   * and this package may not depend on it.
   */
  connections?: TenantRpcConnectionLookup;
}

export interface ResolvedRpcTarget {
  providerId: ResolvedRpcProviderId;
  projectId: string | null;
  endpoint: string;
  endpointLabel: string;
  headers: Record<string, string>;
  selectionMode: RpcSelectionMode;
  /** Set only for tenant-owned connections; telemetry uses ids, never endpoints. */
  connectionId?: string;
}

export interface RelayTelemetryInput {
  providerId: ResolvedRpcProviderId;
  /** Set for tenant-owned targets so their traffic keeps its own bucket. */
  connectionId?: string;
  methodNames: string[];
  statusCode: number;
  latencyMs: number;
  ok: boolean;
  origin: string | null;
}

const ROUND_ROBIN_CURSOR_KEY = "rpc:relay:round-robin-cursor";
const STATS_KEY_PREFIX = "rpc:relay:stats:";

/**
 * Where a target's counters live.
 *
 * A tenant connection resolves to the vendor's own id, so keying on
 * `providerId` alone put an organization's BYOK traffic in the same bucket as
 * the platform's endpoint for that vendor. The provider list then reported
 * requests, errors and latency SDP never served as its own. Tenant traffic is
 * keyed by connection instead, which also keeps one organization's volume out
 * of another's.
 */
function statsKey(providerId: ResolvedRpcProviderId, connectionId?: string): string {
  return connectionId
    ? `${STATS_KEY_PREFIX}tenant:${connectionId}`
    : `${STATS_KEY_PREFIX}${providerId}`;
}
const MAX_ORIGIN_BUCKETS = 20;
const SEND_TRANSACTION_METHOD = ["send", "Transaction"].join("");
const SEND_RAW_TRANSACTION_METHOD = ["sendRaw", "Transaction"].join("");
const TRANSACTION_METHOD_NAMES = new Set([SEND_TRANSACTION_METHOD, SEND_RAW_TRANSACTION_METHOD]);
const MANAGED_RPC_PROVIDER_SET = new Set<string>(ORGANIZATION_RPC_PROVIDERS);
const PROJECT_RPC_PROVIDER_SET = new Set<string>(PROJECT_RPC_PROVIDERS);

type SdpDeploymentMode = "managed" | "self_hosted";

const VALID_DEPLOYMENT_MODES = new Set<string>(["managed", "self_hosted"]);

type OrganizationProviderRow = {
  tier: string;
  settings: unknown | null;
};

type ProviderAvailabilityDefinition = {
  isConfigured: (env: RpcEnv) => boolean;
};

const RPC_PROVIDER_AVAILABILITY_DEFINITIONS = {
  default: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_URL"),
  },
  alchemy: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_ALCHEMY_URL"),
  },
  helius: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_HELIUS_URL"),
  },
  nodit: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_NODIT_URL"),
  },
  quicknode: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_QUICKNODE_URL"),
  },
  triton: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_TRITON_URL"),
  },
  validationcloud: {
    isConfigured: (env) => hasEnv(env, "SOLANA_RPC_VALIDATIONCLOUD_URL"),
  },
} satisfies Record<OrganizationRpcProvider, ProviderAvailabilityDefinition>;

function parsePostgresJson<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function parseOrganizationSettings(raw: unknown | null): OrganizationSettings | null {
  if (!raw) {
    return null;
  }

  try {
    return parsePostgresJson<OrganizationSettings>(raw);
  } catch {
    throw new SdpRpcError("INTERNAL_ERROR", "Organization settings are invalid JSON");
  }
}

function resolveDeploymentMode(value: string | undefined): SdpDeploymentMode {
  if (value === undefined) {
    return "managed";
  }
  if (!VALID_DEPLOYMENT_MODES.has(value)) {
    throw new Error(
      `Invalid SDP_DEPLOYMENT_MODE: "${value}". Expected "managed" or "self_hosted".`
    );
  }
  return value as SdpDeploymentMode;
}

function isSelfHostedDeployment(env: Pick<RpcEnv, "SDP_DEPLOYMENT_MODE">): boolean {
  return resolveDeploymentMode(env.SDP_DEPLOYMENT_MODE) === "self_hosted";
}

function hasEnv(env: RpcEnv, key: keyof RpcEnv): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function buildConfiguredRpcProviders(env: RpcEnv): Record<OrganizationRpcProvider, boolean> {
  return Object.fromEntries(
    Object.entries(RPC_PROVIDER_AVAILABILITY_DEFINITIONS).map(([providerId, definition]) => [
      providerId,
      definition.isConfigured(env),
    ])
  ) as Record<OrganizationRpcProvider, boolean>;
}

function applySelfHostedEntitlements<T extends string>(
  shape: Record<T, boolean>,
  overrides?: Partial<Record<T, boolean>>
): Record<T, boolean> {
  const next = {} as Record<T, boolean>;
  for (const key of Object.keys(shape) as T[]) {
    next[key] = overrides?.[key] !== false;
  }
  return next;
}

function buildAvailabilityEntries<T extends string>(
  entitled: Record<T, boolean>,
  configured: Record<T, boolean>
): Record<T, ProviderAvailabilityEntry> {
  return Object.fromEntries(
    Object.keys(entitled).map((key) => {
      const isEntitled = entitled[key as T] ?? false;
      const isConfigured = configured[key as T] ?? false;

      return [
        key,
        {
          entitled: isEntitled,
          configured: isConfigured,
          enabled: isEntitled && isConfigured,
        },
      ];
    })
  ) as Record<T, ProviderAvailabilityEntry>;
}

function isManagedRpcProviderId(value: string): value is ManagedRpcProviderId {
  return MANAGED_RPC_PROVIDER_SET.has(value);
}

function isProjectRpcProviderId(value: string): value is ProjectRpcProvider {
  return PROJECT_RPC_PROVIDER_SET.has(value);
}

function collectRpcApiKeys(env: RpcEnv): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("SOLANA_RPC_") &&
      key.endsWith("_API_KEY") &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      secrets.push(value);
      if (value !== value.trim()) {
        secrets.push(value.trim());
      }
    }
  }
  // Longest first: replacing a shorter overlapping key before a longer one
  // would mangle the longer key's match and leave a partial secret behind.
  return secrets.sort((a, b) => b.length - a.length);
}

// Redact provider API keys before an endpoint is exposed to callers. The
// query-param heuristic covers keys passed as query values (Helius) and
// customer-supplied custom endpoints whose secret we don't know. The known-key
// redaction covers path-segment keys (Alchemy, QuickNode, Triton, Validation
// Cloud, Nodit), which the query heuristic alone would leave in the path.
function maskEndpoint(url: string, env: RpcEnv): string {
  let masked = url;
  for (const secret of collectRpcApiKeys(env)) {
    masked = masked.replaceAll(secret, "***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      masked = masked.replaceAll(encoded, "***");
    }
  }

  try {
    const parsed = new URL(masked);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("token")) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return masked;
  }
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.origin.slice(0, 200);
  } catch {
    return trimmed.slice(0, 200);
  }
}

function emptyStats(): RpcProviderStatsRecord {
  return {
    requestsTotal: 0,
    transactionRequests: 0,
    errorsTotal: 0,
    latencyTotalMs: 0,
    lastRequestAt: null,
    lastStatusCode: null,
    lastMethod: null,
    origins: {},
  };
}

function toStatsSummary(record: RpcProviderStatsRecord): RpcProviderStatsSummary {
  return {
    requestsTotal: record.requestsTotal,
    transactionRequests: record.transactionRequests,
    errorsTotal: record.errorsTotal,
    averageLatencyMs:
      record.requestsTotal > 0 ? Math.round(record.latencyTotalMs / record.requestsTotal) : 0,
    lastRequestAt: record.lastRequestAt,
    lastStatusCode: record.lastStatusCode,
    lastMethod: record.lastMethod,
    origins: record.origins,
  };
}

function resolveManagedProviders(env: RpcEnv): ManagedRpcProvider[] {
  const providers: ManagedRpcProvider[] = [];

  if (env.SOLANA_RPC_TRITON_URL) {
    const headers: Record<string, string> = {};
    if (env.SOLANA_RPC_TRITON_API_KEY) {
      headers["x-api-key"] = env.SOLANA_RPC_TRITON_API_KEY;
    }
    providers.push({
      id: "triton",
      url: applyApiKeyTemplate(env.SOLANA_RPC_TRITON_URL, env.SOLANA_RPC_TRITON_API_KEY ?? ""),
      headers,
    });
  }

  if (env.SOLANA_RPC_HELIUS_URL) {
    providers.push({
      id: "helius",
      url: withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY),
      headers: {},
    });
  }

  if (env.SOLANA_RPC_ALCHEMY_URL) {
    providers.push({
      id: "alchemy",
      url: withAlchemyApiKey(env.SOLANA_RPC_ALCHEMY_URL, env.SOLANA_RPC_ALCHEMY_API_KEY),
      headers: {},
    });
  }

  if (env.SOLANA_RPC_QUICKNODE_URL) {
    providers.push({
      id: "quicknode",
      url: withOptionalApiKeyTemplate(
        env.SOLANA_RPC_QUICKNODE_URL,
        env.SOLANA_RPC_QUICKNODE_API_KEY
      ),
      headers: {},
    });
  }

  if (env.SOLANA_RPC_VALIDATIONCLOUD_URL) {
    providers.push({
      id: "validationcloud",
      url: applyApiKeyTemplate(
        env.SOLANA_RPC_VALIDATIONCLOUD_URL,
        env.SOLANA_RPC_VALIDATIONCLOUD_API_KEY ?? ""
      ),
      headers: {},
    });
  }

  if (env.SOLANA_RPC_NODIT_URL) {
    providers.push({
      id: "nodit",
      url: withOptionalApiKeyTemplate(env.SOLANA_RPC_NODIT_URL, env.SOLANA_RPC_NODIT_API_KEY),
      headers: {},
    });
  }

  if (env.SOLANA_RPC_URL) {
    providers.push({
      id: "default",
      url: env.SOLANA_RPC_URL,
      headers: {},
    });
  }

  const preferredDefault = env.SOLANA_RPC_DEFAULT_PROVIDER;
  if (preferredDefault && isManagedRpcProviderId(preferredDefault)) {
    const preferred = providers.find((provider) => provider.id === preferredDefault);
    if (preferred) {
      return [preferred, ...providers.filter((provider) => provider.id !== preferredDefault)];
    }
  }

  return providers;
}

async function getOrganizationSettings(
  db: DatabaseClient,
  organizationId: string
): Promise<OrganizationSettings | null> {
  const row = await db
    .prepare(
      `SELECT settings
       FROM organizations
       WHERE id = ?`
    )
    .bind(organizationId)
    .first<{ settings: string | null }>();

  if (!row) {
    throw new SdpRpcError("NOT_FOUND", "Organization not found");
  }

  if (!row.settings) {
    return null;
  }

  return parseOrganizationSettings(row.settings);
}

async function getRpcProviderAvailability(
  env: RpcEnv,
  db: DatabaseClient,
  organizationId: string
): Promise<Record<OrganizationRpcProvider, ProviderAvailabilityEntry>> {
  const row = await db
    .prepare(
      `SELECT tier, settings
       FROM organizations
       WHERE id = ?`
    )
    .bind(organizationId)
    .first<OrganizationProviderRow>();

  if (!row) {
    throw new SdpRpcError("NOT_FOUND", "Organization not found");
  }

  const settings = parseOrganizationSettings(row.settings);
  const tier = normalizeOrganizationTier(row.tier);
  const resolved = resolveOrganizationProviderEntitlements({
    tier,
    providerOverrides: settings?.providerOverrides,
  });
  const configured = buildConfiguredRpcProviders(env);
  const entitled = isSelfHostedDeployment(env)
    ? applySelfHostedEntitlements(resolved.providers.rpc, settings?.providerOverrides?.rpc)
    : resolved.providers.rpc;

  return buildAvailabilityEntries(entitled, configured);
}

async function getProjectSettings(
  db: DatabaseClient,
  organizationId: string,
  projectId: string
): Promise<ProjectSettings | null> {
  const row = await db
    .prepare(
      `SELECT settings
       FROM projects
       WHERE id = ?
         AND organization_id = ?
         AND status = 'active'`
    )
    .bind(projectId, organizationId)
    .first<{ settings: string | null }>();

  if (!row) {
    throw new SdpRpcError("NOT_FOUND", "Project not found");
  }

  if (!row.settings) {
    return null;
  }

  try {
    return parsePostgresJson<ProjectSettings>(row.settings);
  } catch {
    throw new SdpRpcError("INTERNAL_ERROR", "Project settings are invalid JSON");
  }
}

function resolveProjectRpcPreference(
  projectSettings: ProjectSettings | null
):
  | { providerType: "default" }
  | { providerType: "managed"; providerId: ManagedRpcProviderId }
  | { providerType: "custom"; endpoint: string } {
  const explicitProvider = projectSettings?.rpcProvider;
  if (explicitProvider && !isProjectRpcProviderId(explicitProvider)) {
    throw new SdpRpcError(
      "INTERNAL_ERROR",
      `Project RPC provider '${explicitProvider}' is invalid`
    );
  }

  const provider = explicitProvider ?? (projectSettings?.rpcEndpoint ? "custom" : "default");
  if (provider === "default") {
    return { providerType: "default" };
  }

  if (provider === "custom") {
    const endpoint = projectSettings?.rpcEndpoint?.trim();
    if (!endpoint) {
      throw new SdpRpcError(
        "BAD_REQUEST",
        "Project RPC provider is 'custom' but rpcEndpoint is not configured"
      );
    }
    return { providerType: "custom", endpoint };
  }

  return { providerType: "managed", providerId: provider };
}

async function pickRoundRobinProvider(
  cache: KVStore,
  providers: ManagedRpcProvider[]
): Promise<ManagedRpcProvider> {
  if (providers.length === 0) {
    throw new SdpRpcError("SOLANA_RPC_ERROR", "No managed Solana RPC providers are configured");
  }

  if (providers.length === 1) {
    return providers[0];
  }

  const rawCursor = await cache.get(ROUND_ROBIN_CURSOR_KEY);
  const parsedCursor = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
  const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const index = cursor % providers.length;
  const nextCursor = (index + 1) % providers.length;

  await cache.put(ROUND_ROBIN_CURSOR_KEY, String(nextCursor));
  return providers[index];
}

async function pickRoundRobinProviderOrder(
  cache: KVStore,
  providers: ManagedRpcProvider[]
): Promise<ManagedRpcProvider[]> {
  const selectedProvider = await pickRoundRobinProvider(cache, providers);
  const selectedIndex = providers.findIndex((provider) => provider.id === selectedProvider.id);
  if (selectedIndex <= 0) {
    return providers;
  }

  return [...providers.slice(selectedIndex), ...providers.slice(0, selectedIndex)];
}

function validateRequestedProjectScope(
  authProjectId: string | null,
  requestedProjectId: string | null
) {
  if (authProjectId && requestedProjectId && requestedProjectId !== authProjectId) {
    throw new SdpRpcError(
      "FORBIDDEN",
      "Project-scoped API keys cannot relay requests for another project"
    );
  }
}

function getEffectiveProjectId(
  authProjectId: string | null,
  requestedProjectId: string | null
): string | null {
  validateRequestedProjectScope(authProjectId, requestedProjectId);
  return requestedProjectId ?? authProjectId;
}

function isTransactionMethod(methodName: string): boolean {
  return TRANSACTION_METHOD_NAMES.has(methodName);
}

export function includesTransactionMethod(methodNames: string[]): boolean {
  return methodNames.some((methodName) => isTransactionMethod(methodName));
}

const ORGANIZATION_SCOPE_KEY = "__organization__";

/**
 * Tenant connections outrank every platform-managed selection (HOO-1093).
 *
 * A project that holds a connection which is not live fails closed rather than
 * falling through: an organization that has said "use my key" must never have
 * its traffic quietly moved onto credentials SDP pays for.
 *
 * Only the project scope resolves (HOO-1226). Organization-scoped connections
 * are no longer a rail, but they are still checked, because ignoring one is
 * the silent downgrade this whole path exists to prevent.
 */
async function resolveTenantConnection(
  input: ResolveRpcTargetInput,
  projectId: string | null
): Promise<ResolvedRpcTarget | null> {
  if (!input.connections) {
    return null;
  }

  const network = input.env.SOLANA_NETWORK ?? "devnet";

  if (projectId) {
    const resolution = await input.connections.resolve({
      organizationId: input.organizationId,
      scopeKey: projectId,
      network,
    });

    if (resolution.kind === "unusable") {
      throw new SdpRpcError(
        "SOLANA_RPC_ERROR",
        `The RPC connection for this project is not active (${resolution.reason})`
      );
    }

    if (resolution.kind === "active") {
      return {
        providerId: resolution.providerId,
        projectId,
        endpoint: resolution.endpoint,
        endpointLabel: resolution.endpointLabel,
        headers: resolution.headers,
        selectionMode: "project_connection",
        connectionId: resolution.connectionId,
      };
    }
  }

  await assertNoStrandedOrganizationConnection(input, network);

  // Nothing of the tenant's own resolved. Whether that may fall through to a
  // platform provider is the organization's call, not ours.
  const mode = (await input.connections.credentialMode?.(input.organizationId)) ?? "managed";
  if (mode === "byok") {
    throw new SdpRpcError(
      "SOLANA_RPC_ERROR",
      "This organization runs RPC on its own credentials and this project has no live connection. Add one, or switch the organization back to SDP-managed RPC."
    );
  }

  return null;
}

/**
 * Connections were organization-scoped until HOO-1226, and the dashboard only
 * ever created them that way, so every connection made before the cutover sits
 * on a scope the relay no longer reads.
 *
 * Falling through to a platform provider here would answer the request on SDP's
 * keys and say nothing, which is precisely the outcome the tenant paid their
 * own provider to avoid. Refusing is the loud version of the same failure: the
 * connection is visible in the dashboard, and recreating it on a project fixes
 * it.
 */
async function assertNoStrandedOrganizationConnection(
  input: ResolveRpcTargetInput,
  network: string
): Promise<void> {
  const resolution = await input.connections?.resolve({
    organizationId: input.organizationId,
    scopeKey: ORGANIZATION_SCOPE_KEY,
    network,
  });

  // `none` is the ordinary case: no organization connection was ever made.
  if (!resolution || resolution.kind === "none") {
    return;
  }

  throw new SdpRpcError(
    "SOLANA_RPC_ERROR",
    "This organization has an RPC connection that is no longer used. Recreate it on a project to route through your own provider."
  );
}

export async function resolveRpcTarget(input: ResolveRpcTargetInput): Promise<ResolvedRpcTarget> {
  // Precedence 1: an explicit tenant connection on the project, ahead of
  // anything platform-managed.
  const tenantTarget = await resolveTenantConnection(
    input,
    getEffectiveProjectId(input.authProjectId, input.requestedProjectId)
  );
  if (tenantTarget) {
    return tenantTarget;
  }

  const managedProviders = resolveManagedProviders(input.env);
  const access = await getRpcProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access[provider.id]?.enabled
  );
  const projectId = getEffectiveProjectId(input.authProjectId, input.requestedProjectId);

  if (projectId) {
    const projectSettings = await getProjectSettings(input.db, input.organizationId, projectId);
    const projectPreference = resolveProjectRpcPreference(projectSettings);

    if (projectPreference.providerType === "custom") {
      return {
        providerId: "custom",
        projectId,
        endpoint: projectPreference.endpoint,
        endpointLabel: maskEndpoint(projectPreference.endpoint, input.env),
        headers: {},
        selectionMode: "project_custom_provider",
      };
    }

    if (projectPreference.providerType === "managed") {
      const selectedProvider = enabledManagedProviders.find(
        (provider) => provider.id === projectPreference.providerId
      );

      if (selectedProvider) {
        return {
          providerId: selectedProvider.id,
          projectId,
          endpoint: selectedProvider.url,
          endpointLabel: maskEndpoint(selectedProvider.url, input.env),
          headers: selectedProvider.headers,
          selectionMode: "project_provider",
        };
      }
    }
  }

  const organizationSettings = await getOrganizationSettings(input.db, input.organizationId);
  const preferredProvider = organizationSettings?.rpcProvider;

  if (preferredProvider && preferredProvider !== "default") {
    const selectedProvider = enabledManagedProviders.find(
      (provider) => provider.id === preferredProvider
    );

    if (selectedProvider) {
      return {
        providerId: selectedProvider.id,
        projectId,
        endpoint: selectedProvider.url,
        endpointLabel: maskEndpoint(selectedProvider.url, input.env),
        headers: selectedProvider.headers,
        selectionMode: "organization_provider",
      };
    }
  }

  const selectedProvider = await pickRoundRobinProvider(input.kv.cache, enabledManagedProviders);
  return {
    providerId: selectedProvider.id,
    projectId,
    endpoint: selectedProvider.url,
    endpointLabel: maskEndpoint(selectedProvider.url, input.env),
    headers: selectedProvider.headers,
    selectionMode: "round_robin_default",
  };
}

export async function resolveRoundRobinRpcTargets(
  input: ResolveRpcTargetInput
): Promise<ResolvedRpcTarget[]> {
  // The faucet path resolves tenant connections on the same terms as the
  // ordinary relay. Without this an organization that said "use my key" would
  // still have airdrop requests served by platform credentials, and a
  // connection that should fail closed would be bypassed rather than honoured.
  const tenantTarget = await resolveTenantConnection(
    input,
    getEffectiveProjectId(input.authProjectId, input.requestedProjectId)
  );
  if (tenantTarget) {
    // One connection, so there is nothing to rotate between.
    return [tenantTarget];
  }

  const managedProviders = resolveManagedProviders(input.env);
  const access = await getRpcProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access[provider.id]?.enabled
  );
  const projectId = getEffectiveProjectId(input.authProjectId, input.requestedProjectId);
  const orderedProviders = await pickRoundRobinProviderOrder(
    input.kv.cache,
    enabledManagedProviders
  );

  return orderedProviders.map((provider) => ({
    providerId: provider.id,
    projectId,
    endpoint: provider.url,
    endpointLabel: maskEndpoint(provider.url, input.env),
    headers: provider.headers,
    selectionMode: "round_robin_default",
  }));
}

export async function recordRpcRelayTelemetry(cache: KVStore, telemetry: RelayTelemetryInput) {
  const key = statsKey(telemetry.providerId, telemetry.connectionId);
  const existing = (await cache.get(key, "json")) as Partial<RpcProviderStatsRecord> | null;
  const stats: RpcProviderStatsRecord = {
    ...emptyStats(),
    ...existing,
    origins: existing?.origins ?? {},
  };

  stats.requestsTotal += 1;
  stats.latencyTotalMs += Math.max(0, Math.round(telemetry.latencyMs));
  if (!telemetry.ok) {
    stats.errorsTotal += 1;
  }
  if (includesTransactionMethod(telemetry.methodNames)) {
    stats.transactionRequests += 1;
  }

  stats.lastRequestAt = new Date().toISOString();
  stats.lastStatusCode = telemetry.statusCode;
  stats.lastMethod = telemetry.methodNames[0] ?? null;

  const origin = normalizeOrigin(telemetry.origin);
  if (origin) {
    const nextOrigins = {
      ...stats.origins,
      [origin]: (stats.origins[origin] ?? 0) + 1,
    };
    const entries = Object.entries(nextOrigins).sort((a, b) => b[1] - a[1]);
    stats.origins = Object.fromEntries(entries.slice(0, MAX_ORIGIN_BUCKETS));
  }

  await cache.put(key, JSON.stringify(stats));
}

async function getProviderStats(
  cache: KVStore,
  providerId: ResolvedRpcProviderId,
  connectionId?: string
): Promise<RpcProviderStatsSummary> {
  const key = statsKey(providerId, connectionId);
  const existing = (await cache.get(key, "json")) as RpcProviderStatsRecord | null;
  return toStatsSummary(existing ?? emptyStats());
}

export async function listRpcProviders(input: ResolveRpcTargetInput) {
  const managedProviders = resolveManagedProviders(input.env);
  const access = await getRpcProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access[provider.id]?.enabled
  );
  const providerStatuses: RpcProviderStatus[] = [];

  for (const provider of enabledManagedProviders) {
    providerStatuses.push({
      id: provider.id,
      endpoint: maskEndpoint(provider.url, input.env),
      stats: await getProviderStats(input.kv.cache, provider.id),
    });
  }

  const resolvedTarget = await resolveRpcTarget(input);

  return {
    providers: providerStatuses,
    selected: {
      providerId: resolvedTarget.providerId,
      projectId: resolvedTarget.projectId,
      selectionMode: resolvedTarget.selectionMode,
      endpoint: resolvedTarget.endpointLabel,
      stats: await getProviderStats(
        input.kv.cache,
        resolvedTarget.providerId,
        resolvedTarget.connectionId
      ),
    },
    roundRobinOrder: enabledManagedProviders.map((provider) => provider.id),
  };
}
