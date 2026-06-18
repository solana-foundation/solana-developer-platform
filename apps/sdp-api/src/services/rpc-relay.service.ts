import {
  ORGANIZATION_RPC_PROVIDERS,
  type OrganizationRpcProvider,
  type OrganizationSettings,
  PROJECT_RPC_PROVIDERS,
  type ProjectRpcProvider,
  type ProjectSettings,
} from "@sdp/types";
import { parsePostgresJson } from "@/db/postgres-utils";
import { AppError } from "@/lib/errors";
import type { KVStore, KVStoreSet } from "@/runtime/kv";
import { getProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

export type ManagedRpcProviderId = OrganizationRpcProvider;
export type ResolvedRpcProviderId = ManagedRpcProviderId | "custom";
export type RpcSelectionMode =
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

export interface ResolveRpcTargetInput {
  env: Env;
  kv: KVStoreSet;
  db: DatabaseClient;
  organizationId: string;
  authProjectId: string | null;
  requestedProjectId: string | null;
}

export interface ResolvedRpcTarget {
  providerId: ResolvedRpcProviderId;
  projectId: string | null;
  endpoint: string;
  endpointLabel: string;
  headers: Record<string, string>;
  selectionMode: RpcSelectionMode;
}

export interface RelayTelemetryInput {
  providerId: ResolvedRpcProviderId;
  methodNames: string[];
  statusCode: number;
  latencyMs: number;
  ok: boolean;
  origin: string | null;
}

const ROUND_ROBIN_CURSOR_KEY = "rpc:relay:round-robin-cursor";
const STATS_KEY_PREFIX = "rpc:relay:stats:";
const MAX_ORIGIN_BUCKETS = 20;
const SEND_TRANSACTION_METHOD = ["send", "Transaction"].join("");
const SEND_RAW_TRANSACTION_METHOD = ["sendRaw", "Transaction"].join("");
const TRANSACTION_METHOD_NAMES = new Set([SEND_TRANSACTION_METHOD, SEND_RAW_TRANSACTION_METHOD]);
const MANAGED_RPC_PROVIDER_SET = new Set<string>(ORGANIZATION_RPC_PROVIDERS);
const PROJECT_RPC_PROVIDER_SET = new Set<string>(PROJECT_RPC_PROVIDERS);

function isManagedRpcProviderId(value: string): value is ManagedRpcProviderId {
  return MANAGED_RPC_PROVIDER_SET.has(value);
}

function isProjectRpcProviderId(value: string): value is ProjectRpcProvider {
  return PROJECT_RPC_PROVIDER_SET.has(value);
}

function applyApiKeyTemplate(url: string, apiKey: string): string {
  return url
    .replaceAll("${API_KEY}", encodeURIComponent(apiKey))
    .replaceAll("{API_KEY}", encodeURIComponent(apiKey));
}

function appendQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export function withHeliusApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  return appendQueryParam(url, "api-key", apiKey);
}

function withAlchemyApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  if (url.endsWith("/v2")) {
    return `${url}/${encodeURIComponent(apiKey)}`;
  }
  if (url.endsWith("/v2/")) {
    return `${url}${encodeURIComponent(apiKey)}`;
  }

  return appendQueryParam(url, "api_key", apiKey);
}

export function withQuickNodeApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }
  return applyApiKeyTemplate(url, apiKey);
}

function maskEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("token")) {
        parsed.searchParams.set(key, "***");
      }
    }
    return parsed.toString();
  } catch {
    return url;
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

function resolveManagedProviders(env: Env): ManagedRpcProvider[] {
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
      url: withQuickNodeApiKey(env.SOLANA_RPC_QUICKNODE_URL, env.SOLANA_RPC_QUICKNODE_API_KEY),
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
    throw new AppError("NOT_FOUND", "Organization not found");
  }

  if (!row.settings) {
    return null;
  }

  try {
    return parsePostgresJson<OrganizationSettings>(row.settings);
  } catch {
    throw new AppError("INTERNAL_ERROR", "Organization settings are invalid JSON");
  }
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
    throw new AppError("NOT_FOUND", "Project not found");
  }

  if (!row.settings) {
    return null;
  }

  try {
    return parsePostgresJson<ProjectSettings>(row.settings);
  } catch {
    throw new AppError("INTERNAL_ERROR", "Project settings are invalid JSON");
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
    throw new AppError("INTERNAL_ERROR", `Project RPC provider '${explicitProvider}' is invalid`);
  }

  const provider = explicitProvider ?? (projectSettings?.rpcEndpoint ? "custom" : "default");
  if (provider === "default") {
    return { providerType: "default" };
  }

  if (provider === "custom") {
    const endpoint = projectSettings?.rpcEndpoint?.trim();
    if (!endpoint) {
      throw new AppError(
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
    throw new AppError("SOLANA_RPC_ERROR", "No managed Solana RPC providers are configured");
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
    throw new AppError(
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

export async function resolveRpcTarget(input: ResolveRpcTargetInput): Promise<ResolvedRpcTarget> {
  const managedProviders = resolveManagedProviders(input.env);
  const access = await getProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access.providers.rpc[provider.id]?.enabled
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
        endpointLabel: maskEndpoint(projectPreference.endpoint),
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
          endpointLabel: maskEndpoint(selectedProvider.url),
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
        endpointLabel: maskEndpoint(selectedProvider.url),
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
    endpointLabel: maskEndpoint(selectedProvider.url),
    headers: selectedProvider.headers,
    selectionMode: "round_robin_default",
  };
}

export async function resolveRoundRobinRpcTargets(
  input: ResolveRpcTargetInput
): Promise<ResolvedRpcTarget[]> {
  const managedProviders = resolveManagedProviders(input.env);
  const access = await getProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access.providers.rpc[provider.id]?.enabled
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
    endpointLabel: maskEndpoint(provider.url),
    headers: provider.headers,
    selectionMode: "round_robin_default",
  }));
}

export async function recordRpcRelayTelemetry(cache: KVStore, telemetry: RelayTelemetryInput) {
  const key = `${STATS_KEY_PREFIX}${telemetry.providerId}`;
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
  providerId: ResolvedRpcProviderId
): Promise<RpcProviderStatsSummary> {
  const key = `${STATS_KEY_PREFIX}${providerId}`;
  const existing = (await cache.get(key, "json")) as RpcProviderStatsRecord | null;
  return toStatsSummary(existing ?? emptyStats());
}

export async function listRpcProviders(input: ResolveRpcTargetInput) {
  const managedProviders = resolveManagedProviders(input.env);
  const access = await getProviderAvailability(input.env, input.db, input.organizationId);
  const enabledManagedProviders = managedProviders.filter(
    (provider) => access.providers.rpc[provider.id]?.enabled
  );
  const providerStatuses: RpcProviderStatus[] = [];

  for (const provider of enabledManagedProviders) {
    providerStatuses.push({
      id: provider.id,
      endpoint: maskEndpoint(provider.url),
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
      stats: await getProviderStats(input.kv.cache, resolvedTarget.providerId),
    },
    roundRobinOrder: enabledManagedProviders.map((provider) => provider.id),
  };
}
