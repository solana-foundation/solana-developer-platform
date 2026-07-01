import type {
  CustodyWalletAggregate,
  CustodyWalletSummary,
  CustodyWalletTokenBalance,
} from "@sdp/types";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { getDb } from "@/db";
import { formatDecimalAmount } from "@/lib/amount";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { created, success } from "@/lib/response";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { resolveIssuedTokenLabelsByMint } from "@/routes/payments/token-labels";
import {
  assertApiKeyWalletAccess,
  getAllowedApiKeyWalletIdsForPermissions,
  resolveApiKeySigningWalletId,
} from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { CUSTODY_PROVIDERS, type CustodyProvider } from "@/services/custody/providers";
import * as signingServiceModule from "@/services/domain/signing.service";
import {
  aggregateTrackedWalletBalances,
  attachTokenSymbolsToBalanceMap,
  attachUsdValuesToBalanceMap,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { SigningError } from "@/services/ports";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import * as solanaRpc from "@/services/solana/rpc";
import { type AppContext, parseBooleanQueryParam, resolveActor } from "../context";
import {
  type CustodyWalletAggregateResponse,
  type CustodyWalletByIdResponse,
  type CustodyWalletResponse,
  type CustodyWalletsResponse,
  createWalletSchema,
  type DeleteWalletResponse,
  deleteWalletSchema,
  setDefaultWalletSchema,
  updateWalletSchema,
} from "../schemas";

const SUMMARY_CACHE_TTL_MS = 15_000;
const AGGREGATE_CACHE_TTL_MS = 10_000;
const WALLET_BALANCE_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface WalletSummaryConfigRow {
  id: string;
}

interface WalletSummaryRow {
  id: string;
  custody_config_id: string;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: string | null;
  status: string;
  created_at: string;
  provider: string;
}

const walletSummaryCache = new Map<string, CacheEntry<CustodyWalletSummary[]>>();
const walletAggregateCache = new Map<string, CacheEntry<CustodyWalletAggregate>>();
const walletBalanceCache = new Map<string, CacheEntry<CustodyWalletTokenBalance[]>>();

export function clearWalletCaches() {
  walletSummaryCache.clear();
  walletAggregateCache.clear();
  walletBalanceCache.clear();
}

function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });

  return value;
}

function buildWalletBalanceCacheKey(c: AppContext, publicKey: string): string {
  const auth = getAuth(c);
  return `${auth.organizationId}:${auth.projectId ?? "org"}:${publicKey}`;
}

function logWalletStep(
  c: AppContext,
  route: "list_wallets" | "aggregate_wallets",
  step: string,
  startedAt: number,
  extra: Record<string, unknown> = {}
) {
  console.info(
    JSON.stringify({
      event: "sdp_api_wallets_step",
      timestamp: new Date().toISOString(),
      requestId: c.get("requestId"),
      traceId: c.get("traceId") ?? null,
      route,
      step,
      durationMs: Number((performance.now() - startedAt).toFixed(1)),
      ...extra,
    })
  );
}

async function resolveDefaultConfigId(
  db: DatabaseClient,
  organizationId: string,
  projectId?: string
): Promise<string | null> {
  if (projectId) {
    const scopedDefault = await db
      .prepare(
        `SELECT default_custody_config_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?
         LIMIT 1`
      )
      .bind(organizationId, projectId)
      .first<{ default_custody_config_id: string }>();

    if (scopedDefault?.default_custody_config_id) {
      return scopedDefault.default_custody_config_id;
    }
  }

  const orgDefault = await db
    .prepare(
      `SELECT default_custody_config_id
       FROM custody_scope_defaults
       WHERE organization_id = ? AND project_id IS NULL
       LIMIT 1`
    )
    .bind(organizationId)
    .first<{ default_custody_config_id: string }>();

  return orgDefault?.default_custody_config_id ?? null;
}

async function resolveSummaryConfigIds(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>
): Promise<{ configIds: string[]; defaultConfigId: string | null }> {
  const actor = resolveActor(c);
  const defaultConfigId = await resolveDefaultConfigId(
    getDb(c.env),
    actor.organizationId,
    filters.projectId
  );

  if (filters.includeAllProviders) {
    const includeAllProvidersQuery = filters.projectId
      ? `SELECT id
         FROM custody_configs
         WHERE organization_id = ?
           AND status = 'active'
           AND (project_id = ? OR project_id IS NULL)
           ${filters.provider ? "AND provider = ?" : ""}
         ORDER BY updated_at DESC, id DESC`
      : `SELECT id
         FROM custody_configs
         WHERE organization_id = ?
           AND status = 'active'
           AND project_id IS NULL
           ${filters.provider ? "AND provider = ?" : ""}
         ORDER BY updated_at DESC, id DESC`;

    const rows = await getDb(c.env)
      .prepare(includeAllProvidersQuery)
      .bind(
        ...(filters.projectId
          ? filters.provider
            ? [actor.organizationId, filters.projectId, filters.provider]
            : [actor.organizationId, filters.projectId]
          : filters.provider
            ? [actor.organizationId, filters.provider]
            : [actor.organizationId])
      )
      .all<WalletSummaryConfigRow>();

    return {
      configIds: (rows.results ?? []).map((row) => row.id),
      defaultConfigId,
    };
  }

  if (filters.provider) {
    const providerRow = filters.projectId
      ? await getDb(c.env)
          .prepare(
            `SELECT id
           FROM custody_configs
           WHERE organization_id = ?
             AND status = 'active'
             AND provider = ?
             AND (project_id = ? OR project_id IS NULL)
           ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC
           LIMIT 1`
          )
          .bind(actor.organizationId, filters.provider, filters.projectId, filters.projectId)
          .first<WalletSummaryConfigRow>()
      : await getDb(c.env)
          .prepare(
            `SELECT id
           FROM custody_configs
           WHERE organization_id = ?
             AND status = 'active'
             AND provider = ?
             AND project_id IS NULL
           LIMIT 1`
          )
          .bind(actor.organizationId, filters.provider)
          .first<WalletSummaryConfigRow>();

    return {
      configIds: providerRow?.id ? [providerRow.id] : [],
      defaultConfigId,
    };
  }

  return {
    configIds: defaultConfigId ? [defaultConfigId] : [],
    defaultConfigId,
  };
}

async function queryWalletSummaries(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>
): Promise<CustodyWalletSummary[]> {
  const auth = getAuth(c);
  const { configIds, defaultConfigId } = await resolveSummaryConfigIds(c, filters);
  if (configIds.length === 0) {
    return [];
  }

  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["wallets:read"]);
  if (allowedWalletIds !== null && allowedWalletIds.length === 0) {
    return [];
  }
  const configPlaceholders = configIds.map(() => "?").join(", ");
  const allowedWalletClause =
    allowedWalletIds !== null && allowedWalletIds.length > 0
      ? `AND w.wallet_id IN (${allowedWalletIds.map(() => "?").join(", ")})`
      : "";

  const rows = await getDb(c.env)
    .prepare(
      `SELECT
       w.id,
       w.custody_config_id,
       w.wallet_id,
       w.public_key,
       w.label,
       w.purpose,
       w.status,
       w.created_at,
       c.provider
     FROM custody_wallets w
     JOIN custody_configs c ON c.id = w.custody_config_id
     WHERE w.status = 'active'
       AND c.status = 'active'
       AND c.id IN (${configPlaceholders})
       ${allowedWalletClause}
     ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END, c.updated_at DESC, c.id DESC, w.created_at ASC`
    )
    .bind(...configIds, ...(allowedWalletIds ?? []), defaultConfigId ?? "")
    .all<WalletSummaryRow>();

  return (rows.results ?? []).map((row) => ({
    id: row.id,
    custodyConfigId: row.custody_config_id,
    provider: row.provider as CustodyWalletSummary["provider"],
    isDefaultProvider: row.custody_config_id === defaultConfigId,
    walletId: row.wallet_id,
    publicKey: row.public_key,
    label: row.label,
    purpose: row.purpose,
    status: row.status as CustodyWalletSummary["status"],
    createdAt: row.created_at,
  }));
}

function buildWalletCacheKey(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>,
  kind: "summary" | "aggregate"
): string {
  const auth = getAuth(c);
  const actor = resolveActor(c);
  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["wallets:read"]);

  return JSON.stringify({
    kind,
    organizationId: actor.organizationId,
    projectId: filters.projectId ?? null,
    provider: filters.provider ?? null,
    includeAllProviders: filters.includeAllProviders,
    authType: auth.authType,
    apiKeyId: auth.apiKeyId,
    allowedWalletIds: allowedWalletIds ? [...allowedWalletIds].sort() : null,
  });
}

async function getCachedWalletSummaries(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>,
  route: "list_wallets" | "aggregate_wallets"
): Promise<CustodyWalletSummary[]> {
  const cacheKey = buildWalletCacheKey(c, filters, "summary");
  const cached = readCache(walletSummaryCache, cacheKey);
  if (cached) {
    logWalletStep(c, route, "wallet_summary_cache_hit", performance.now(), {
      walletCount: cached.length,
    });
    return cached;
  }

  const startedAt = performance.now();
  const wallets = await queryWalletSummaries(c, filters);
  logWalletStep(c, route, "query_wallet_summaries", startedAt, {
    walletCount: wallets.length,
  });

  return writeCache(walletSummaryCache, cacheKey, wallets, SUMMARY_CACHE_TTL_MS);
}

function resolveWalletFilters(
  c: AppContext,
  options: { defaultIncludeAllProviders?: boolean } = {}
) {
  const projectId = c.get("projectId");
  const providerQuery = c.req.query("provider");
  const includeAllProviders = c.req.query("includeAllProviders");
  const includeBalances = parseBooleanQueryParam(c.req.query("includeBalances"));
  const view = c.req.query("view") === "summary" ? "summary" : "default";

  const provider =
    providerQuery && CUSTODY_PROVIDERS.includes(providerQuery as CustodyProvider)
      ? (providerQuery as CustodyProvider)
      : undefined;

  if (providerQuery && !provider) {
    throw badRequest("Invalid provider query parameter");
  }

  return {
    projectId,
    provider,
    view,
    includeBalances,
    includeAllProviders:
      includeAllProviders === undefined
        ? options.defaultIncludeAllProviders === true
        : parseBooleanQueryParam(includeAllProviders),
  };
}

async function getBalancesByWalletId(
  c: AppContext,
  walletPublicKeys: Array<{ walletId: string; publicKey: string }>,
  options: { includeUsdValues?: boolean } = {}
) {
  const rpc = solanaRpc.createRpc(c.env);
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);
  const balancesByWalletId = await Promise.all(
    walletPublicKeys.map(async (wallet) => {
      const cacheKey = buildWalletBalanceCacheKey(c, wallet.publicKey);
      const cachedBalances = readCache(walletBalanceCache, cacheKey);
      if (cachedBalances) {
        return [wallet.walletId, cachedBalances] as const;
      }

      const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
        solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address),
        tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address, { tokenLabelsByMint }),
      ]);
      const lamports =
        solBalanceResult.status === "fulfilled" ? (solBalanceResult.value?.lamports ?? 0n) : 0n;
      const splBalances = splBalancesResult.status === "fulfilled" ? splBalancesResult.value : [];

      if (solBalanceResult.status === "rejected") {
        console.error("getBalancesByWalletId: failed to fetch SOL balance", {
          requestId: c.get("requestId"),
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
          error:
            solBalanceResult.reason instanceof Error
              ? solBalanceResult.reason.message
              : String(solBalanceResult.reason),
        });
      }

      if (splBalancesResult.status === "rejected") {
        console.error("getBalancesByWalletId: failed to fetch SPL balances", {
          requestId: c.get("requestId"),
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
          error:
            splBalancesResult.reason instanceof Error
              ? splBalancesResult.reason.message
              : String(splBalancesResult.reason),
        });
      }

      const walletBalances = writeCache(
        walletBalanceCache,
        cacheKey,
        [
          {
            token: "SOL",
            mint: tokenAccounts.SOL_MINT,
            amount: lamports.toString(),
            uiAmount: formatDecimalAmount(lamports, 9),
            decimals: 9,
          },
          ...splBalances,
        ],
        WALLET_BALANCE_CACHE_TTL_MS
      );

      return [wallet.walletId, walletBalances] as const;
    })
  );

  const balancesMap = await attachTokenSymbolsToBalanceMap(c.env, new Map(balancesByWalletId));

  if (options.includeUsdValues === false) {
    return balancesMap;
  }

  return attachUsdValuesToBalanceMap(c.env, balancesMap);
}

export const createWallet = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.get("projectId");

  const body = await c.req.json();
  const parsed = createWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const signingService = signingServiceModule.createSigningService(c.env);

  try {
    const wallet = await signingService.createWallet(actor.organizationId, projectId, {
      provider: parsed.data.provider,
      label: parsed.data.label,
      purpose: parsed.data.purpose,
      setDefault: parsed.data.setDefault,
    });

    const response: CustodyWalletResponse = {
      wallet: {
        id: wallet.id,
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        label: wallet.label,
        purpose: wallet.purpose,
        status: wallet.status,
        createdAt: wallet.createdAt,
      },
    };

    clearWalletCaches();

    return created(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", error.message);
      }
      throw badRequest(error.message);
    }
    throw error;
  }
};

export const deleteWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = deleteWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const projectId = c.get("projectId");
  const signingService = signingServiceModule.createSigningService(c.env);

  try {
    await signingService.deleteWallet(actor.organizationId, projectId, {
      provider: parsed.data.provider,
      walletId: parsed.data.walletId,
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "delete",
      resourceType: "custody_wallet",
      resourceId: parsed.data.walletId,
      metadata: {
        event: "wallet_deleted",
        walletId: parsed.data.walletId,
        provider: parsed.data.provider ?? null,
        projectId: projectId ?? null,
      },
    });

    const response: DeleteWalletResponse = {
      walletId: parsed.data.walletId,
      deleted: true,
    };

    clearWalletCaches();

    return success(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND" || error.code === "WALLET_NOT_FOUND") {
        throw new AppError("NOT_FOUND", error.message);
      }
      throw badRequest(error.message);
    }
    throw error;
  }
};

export const setDefaultWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = setDefaultWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const projectId = c.get("projectId");
  const signingService = signingServiceModule.createSigningService(c.env);
  const config = parsed.data.provider
    ? await signingService.getConfigurationByProvider(
        actor.organizationId,
        projectId,
        parsed.data.provider
      )
    : await signingService.getConfiguration(actor.organizationId, projectId);

  if (!config?.id) {
    throw new AppError("CONFLICT", "Wallet signing is not initialized");
  }

  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    actor.organizationId,
    "custody",
    config.provider
  );

  const wallet = await getDb(c.env)
    .prepare(
      `SELECT id
     FROM custody_wallets
     WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
     LIMIT 1`
    )
    .bind(config.id, parsed.data.walletId)
    .first<{ id: string }>();

  if (!wallet) {
    throw badRequest("Unknown walletId for this wallet signing configuration");
  }

  await getDb(c.env)
    .prepare(
      `UPDATE custody_configs
     SET default_wallet_id = ?, updated_at = datetime('now')
     WHERE id = ?`
    )
    .bind(parsed.data.walletId, config.id)
    .run();

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "custody_config",
    resourceId: config.id,
    metadata: {
      event: "default_wallet_changed",
      provider: config.provider,
      walletId: parsed.data.walletId,
      projectId: projectId ?? null,
    },
  });

  clearWalletCaches();

  return success(c, { defaultWalletId: parsed.data.walletId });
};

export const updateWallet = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = c.get("projectId");
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }

  const body = await c.req.json();
  const parsed = updateWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const signingService = signingServiceModule.createSigningService(c.env);
  const wallet = await signingService.getWalletById(actor.organizationId, projectId, walletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found");
  }

  try {
    assertApiKeyWalletAccess(auth, wallet.walletId, ["wallets:write"]);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    throw error;
  }

  const nextLabel = parsed.data.label?.trim() ? parsed.data.label.trim() : null;

  await getDb(c.env)
    .prepare(
      `UPDATE custody_wallets
     SET label = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
    )
    .bind(nextLabel, wallet.id)
    .run();

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "custody_wallet",
    resourceId: wallet.id,
    metadata: {
      event: "wallet_label_updated",
      walletId: wallet.walletId,
      previousLabel: wallet.label ?? null,
      label: nextLabel,
      projectId: projectId ?? null,
      provider: wallet.provider ?? null,
    },
  });

  const response: CustodyWalletResponse = {
    wallet: {
      id: wallet.id,
      custodyConfigId: wallet.custodyConfigId,
      provider: wallet.provider,
      isDefaultProvider: wallet.isDefaultProvider,
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      label: nextLabel,
      purpose: wallet.purpose,
      status: wallet.status,
      createdAt: wallet.createdAt,
    },
  };

  clearWalletCaches();

  return success(c, response);
};

export const listWallets = async (c: AppContext) => {
  const filters = resolveWalletFilters(c, { defaultIncludeAllProviders: true });
  const wallets = await getCachedWalletSummaries(c, filters, "list_wallets");
  const balancesStartedAt = performance.now();
  const balancesByWalletId = filters.includeBalances
    ? await getBalancesByWalletId(
        c,
        wallets.map((wallet) => ({
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
        }))
      )
    : new Map<string, CustodyWalletTokenBalance[]>();

  if (filters.includeBalances) {
    logWalletStep(c, "list_wallets", "fetch_wallet_balances", balancesStartedAt, {
      walletCount: wallets.length,
    });
  }

  const response: CustodyWalletsResponse = {
    wallets: wallets.map((wallet) => ({
      id: wallet.id,
      custodyConfigId: wallet.custodyConfigId,
      provider: wallet.provider,
      isDefaultProvider: wallet.isDefaultProvider,
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      label: wallet.label,
      purpose: wallet.purpose,
      status: wallet.status,
      createdAt: wallet.createdAt,
      ...(filters.includeBalances
        ? {
            balances: balancesByWalletId.get(wallet.walletId) ?? [],
          }
        : {}),
    })),
  };

  return success(c, response);
};

export const getWalletAggregate = async (c: AppContext) => {
  const filters = resolveWalletFilters(c, { defaultIncludeAllProviders: true });
  const aggregateCacheKey = buildWalletCacheKey(c, filters, "aggregate");
  const cachedAggregate = readCache(walletAggregateCache, aggregateCacheKey);
  if (cachedAggregate) {
    logWalletStep(c, "aggregate_wallets", "aggregate_cache_hit", performance.now(), {
      walletCount: cachedAggregate.walletCount,
    });
    return success(c, {
      aggregate: cachedAggregate,
    } satisfies CustodyWalletAggregateResponse);
  }

  const wallets = await getCachedWalletSummaries(c, filters, "aggregate_wallets");
  const balancesStartedAt = performance.now();
  const balancesByWalletId = await getBalancesByWalletId(
    c,
    wallets.map((wallet) => ({
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
    })),
    { includeUsdValues: false }
  );
  logWalletStep(c, "aggregate_wallets", "fetch_wallet_balances", balancesStartedAt, {
    walletCount: wallets.length,
  });

  const aggregateStartedAt = performance.now();
  const aggregatedBalances = await attachUsdValuesToBalances(
    c.env,
    aggregateTrackedWalletBalances(
      wallets.map((wallet) => balancesByWalletId.get(wallet.walletId) ?? [])
    )
  );
  logWalletStep(c, "aggregate_wallets", "attach_usd_values", aggregateStartedAt, {
    balanceCount: aggregatedBalances.length,
  });

  const aggregate = writeCache(
    walletAggregateCache,
    aggregateCacheKey,
    {
      walletCount: wallets.length,
      balances: aggregatedBalances,
    },
    AGGREGATE_CACHE_TTL_MS
  );

  const response: CustodyWalletAggregateResponse = {
    aggregate,
  };

  return success(c, response);
};

export const getWalletById = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = c.get("projectId");
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }

  const signingService = signingServiceModule.createSigningService(c.env);
  const wallet = await signingService.getWalletById(actor.organizationId, projectId, walletId);

  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found");
  }

  try {
    assertApiKeyWalletAccess(auth, wallet.walletId, ["wallets:read"]);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    throw error;
  }

  let lamports = 0n;

  try {
    const rpc = solanaRpc.createRpc(c.env);
    const accountInfo = await solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    // biome-ignore lint/security/noSecrets: Operational log message, not a secret.
    console.error("getWalletById: failed to fetch wallet balance", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const solBalance = {
    token: "SOL" as const,
    mint: tokenAccounts.SOL_MINT,
    amount: lamports.toString(),
    uiAmount: formatDecimalAmount(lamports, 9),
    decimals: 9 as const,
  };
  const [pricedSolBalanceResult] = await attachUsdValuesToBalances(c.env, [solBalance]);
  const pricedSolBalance = pricedSolBalanceResult
    ? {
        ...solBalance,
        ...(typeof pricedSolBalanceResult.usdPrice === "number"
          ? { usdPrice: pricedSolBalanceResult.usdPrice }
          : {}),
        ...(typeof pricedSolBalanceResult.usdValue === "number"
          ? { usdValue: pricedSolBalanceResult.usdValue }
          : {}),
      }
    : solBalance;

  const response: CustodyWalletByIdResponse = {
    wallet: {
      id: wallet.id,
      custodyConfigId: wallet.custodyConfigId,
      provider: wallet.provider,
      isDefaultProvider: wallet.isDefaultProvider,
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      label: wallet.label,
      purpose: wallet.purpose,
      status: wallet.status,
      createdAt: wallet.createdAt,
      balance: pricedSolBalance,
    },
  };

  return success(c, response);
};

export const getPublicKey = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = c.get("projectId");
  const requestedWalletId = c.req.query("walletId");

  const signingService = signingServiceModule.createSigningService(c.env);

  try {
    const walletId = resolveApiKeySigningWalletId(auth, requestedWalletId, ["wallets:read"]);
    const publicKey = await signingService.getPublicKey(
      actor.organizationId,
      projectId,
      walletId ?? undefined
    );

    return success(c, { publicKey });
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    if (error instanceof SigningError) {
      throw new AppError("NOT_FOUND", "No signing key configured for this organization");
    }
    throw error;
  }
};
