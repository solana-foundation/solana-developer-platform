import { CUSTODY_PROVIDERS, type CustodyProvider } from "@sdp/custody";
import { SigningError } from "@sdp/custody/signing";
import * as solanaRpc from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { CustodyWalletSummary, CustodyWalletTokenBalance } from "@sdp/types";
import type { Address } from "@solana/kit";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequest, conflict } from "@/lib/errors";
import { isCustodyConnectionRuntimeEnabled } from "@/lib/feature-flags";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import * as tokenAccounts from "@/routes/payments/token-accounts";
import { resolveIssuedTokenLabelsByMint } from "@/routes/payments/token-labels";
import { getLogger } from "@/runtime/logger";
import {
  assertApiKeyNotWalletScoped,
  getAllowedApiKeyCustodyWalletIdsForPermissions,
  resolveApiKeyCustodyWalletId,
  resolveApiKeySigningWalletId,
} from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { assertCustodyProviderCanDeleteWallet } from "@/services/custody-provider-lifecycle.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import * as signingServiceModule from "@/services/domain/signing.service";
import {
  aggregateTrackedWalletBalances,
  attachTokenSymbolsToBalanceMap,
  attachUsdValuesToBalanceMap,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import { type AppContext, parseBooleanQueryParam, resolveActor } from "../context";
import type {
  CustodyWalletAggregateResponse,
  CustodyWalletByIdResponse,
  CustodyWalletMetadataResponse,
  CustodyWalletResponse,
  CustodyWalletsResponse,
  createWalletSchema,
  DeleteWalletResponse,
  deleteWalletSchema,
  setDefaultWalletSchema,
  updateWalletSchema,
} from "../schemas";

const WALLET_BALANCE_CACHE_TTL_MS = 10_000;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const walletBalanceCache = new Map<string, CacheEntry<CustodyWalletTokenBalance[]>>();

export function clearWalletCaches() {
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
  route: "list_wallets" | "aggregate_wallets",
  step: string,
  startedAt: number,
  extra: Record<string, unknown> = {}
) {
  getLogger().info({
    event: "sdp_api_wallets_step",
    route,
    step,
    duration_ms: Number((performance.now() - startedAt).toFixed(1)),
    ...extra,
  });
}

async function queryWalletSummaries(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>
): Promise<CustodyWalletSummary[]> {
  const auth = getAuth(c);
  const allowedWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(auth, ["wallets:read"]);
  if (allowedWalletIds !== null && allowedWalletIds.length === 0) {
    return [];
  }
  const actor = resolveActor(c);
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: actor.organizationId,
    projectId: filters.projectId,
    provider: filters.provider,
    includeAllProviders: filters.includeAllProviders,
  });
  return allowedWalletIds === null
    ? wallets
    : wallets.filter((wallet) => allowedWalletIds.includes(wallet.id));
}

async function findAuthorizedOperationalWallet(
  c: AppContext,
  walletId: string,
  permissions: Parameters<typeof resolveApiKeyCustodyWalletId>[2],
  allowRecordIdAlias = false
) {
  const auth = getAuth(c);
  const actor = resolveActor(c);
  const projectId = c.get("projectId");
  const targets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
  const custodyWalletId = resolveApiKeyCustodyWalletId(
    auth,
    walletId,
    permissions,
    allowRecordIdAlias
  );
  if (custodyWalletId) {
    const wallet = await targets.findOperationalWalletById({
      organizationId: actor.organizationId,
      projectId,
      custodyWalletId,
    });
    if (!wallet || !allowRecordIdAlias) {
      return wallet;
    }

    const collision =
      wallet.walletId === walletId
        ? await targets.findOperationalWalletById({
            organizationId: actor.organizationId,
            projectId,
            custodyWalletId: walletId,
          })
        : await targets.findOperationalWallet({
            organizationId: actor.organizationId,
            projectId,
            walletId,
          });
    if (collision && collision.id !== wallet.id) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    return wallet;
  }

  return targets.findOperationalWallet({
    organizationId: actor.organizationId,
    projectId,
    walletId,
    allowRecordIdAlias,
  });
}

async function getWalletSummaries(
  c: AppContext,
  filters: ReturnType<typeof resolveWalletFilters>,
  route: "list_wallets" | "aggregate_wallets"
): Promise<CustodyWalletSummary[]> {
  const startedAt = performance.now();
  const wallets = await queryWalletSummaries(c, filters);
  logWalletStep(route, "query_wallet_summaries", startedAt, {
    walletCount: wallets.length,
  });
  return wallets;
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
  walletPublicKeys: Array<{ id: string; walletId: string; publicKey: string }>,
  options: { includeUsdValues?: boolean } = {}
) {
  const rpc = solanaRpc.createRpc(c.env);
  const tokenLabelsByMint = await resolveIssuedTokenLabelsByMint(c);
  const balanceEntries = await Promise.all(
    walletPublicKeys.map(async (wallet) => {
      const cacheKey = buildWalletBalanceCacheKey(c, wallet.publicKey);
      const cachedBalances = readCache(walletBalanceCache, cacheKey);
      if (cachedBalances) {
        return [wallet.id, cachedBalances] as const;
      }

      const [solBalanceResult, splBalancesResult] = await Promise.allSettled([
        solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address),
        tokenAccounts.getSplTokenBalances(rpc, wallet.publicKey as Address, {
          tokenLabelsByMint,
        }),
      ]);
      const lamports =
        solBalanceResult.status === "fulfilled" ? (solBalanceResult.value?.lamports ?? 0n) : 0n;
      const splBalances = splBalancesResult.status === "fulfilled" ? splBalancesResult.value : [];

      if (solBalanceResult.status === "rejected") {
        getLogger().error(
          {
            requestId: c.get("requestId"),
            walletId: wallet.walletId,
            publicKey: wallet.publicKey,
            error:
              solBalanceResult.reason instanceof Error
                ? solBalanceResult.reason.message
                : String(solBalanceResult.reason),
          },
          "getBalancesByWalletId: failed to fetch SOL balance"
        );
      }

      if (splBalancesResult.status === "rejected") {
        getLogger().error(
          {
            requestId: c.get("requestId"),
            walletId: wallet.walletId,
            publicKey: wallet.publicKey,
            error:
              splBalancesResult.reason instanceof Error
                ? splBalancesResult.reason.message
                : String(splBalancesResult.reason),
          },
          "getBalancesByWalletId: failed to fetch SPL balances"
        );
      }

      // A partial observation is not a zero balance. Omit this wallet's
      // balance field entirely so callers can distinguish an RPC failure from
      // a successful empty account, and never cache a synthetic zero that
      // would survive the transient failure for the cache TTL.
      if (solBalanceResult.status === "rejected" || splBalancesResult.status === "rejected") {
        return null;
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

      return [wallet.id, walletBalances] as const;
    })
  );

  const balancesByWalletId = balanceEntries.filter(
    (entry): entry is readonly [string, CustodyWalletTokenBalance[]] => entry !== null
  );

  const balancesMap = await attachTokenSymbolsToBalanceMap(c.env, new Map(balancesByWalletId));

  if (options.includeUsdValues === false) {
    return balancesMap;
  }

  return attachUsdValuesToBalanceMap(c.env, balancesMap);
}

export const createWallet = async (c: ValidatedBodyContext<typeof createWalletSchema>) => {
  const actor = resolveActor(c);
  const projectId = c.get("projectId");

  // A freshly created wallet is by definition outside a wallet-scoped key's
  // bindings (and setDefault would re-point the scope's default signer).
  assertApiKeyNotWalletScoped(getAuth(c), "create custody wallets");

  const body = c.req.valid("json");

  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));

  try {
    const runtimeTargets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
    const target = body.connectionId
      ? projectId
        ? await runtimeTargets.resolve({
            kind: "connection",
            organizationId: actor.organizationId,
            projectId,
            connectionId: body.connectionId,
          })
        : null
      : await runtimeTargets.resolve(
          body.provider
            ? {
                kind: "provider",
                organizationId: actor.organizationId,
                projectId,
                provider: body.provider,
              }
            : {
                kind: "effective",
                organizationId: actor.organizationId,
                projectId,
              }
        );
    if (body.connectionId && !target) {
      throw new AppError("NOT_FOUND", "Custody Connection not found");
    }
    if (target?.kind === "connection") {
      const wallet = await runtimeTargets.createConnectionWallet({
        organizationId: actor.organizationId,
        projectId: target.projectId,
        connectionId: target.connectionId,
        provider: body.provider,
        label: body.label,
        purpose: body.purpose,
        setDefault: body.setDefault,
      });
      clearWalletCaches();
      return created(c, { wallet } satisfies CustodyWalletResponse);
    }

    const wallet = await signingService.createWallet(actor.organizationId, projectId, {
      provider: body.provider,
      label: body.label,
      purpose: body.purpose,
      setDefault: body.setDefault,
    });

    const response: CustodyWalletResponse = {
      wallet: {
        id: wallet.id,
        custodyConfigId: wallet.custodyConfigId,
        isRuntimeExecutionAllowed: true,
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

export const deleteWallet = async (c: ValidatedBodyContext<typeof deleteWalletSchema>) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);

  const body = c.req.valid("json");

  let authorizedCustodyWalletId: string | null;
  try {
    authorizedCustodyWalletId = resolveApiKeyCustodyWalletId(getAuth(c), body.walletId, [
      "wallets:write",
    ]);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Custody wallet not found");
    }
    throw error;
  }

  const projectId = c.get("projectId");
  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));

  try {
    const selectedConfig = await signingService.getConfigurationForMutation(
      actor.organizationId,
      projectId,
      body.provider
    );
    const targets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
    const lookupProjectId =
      authorizedCustodyWalletId && auth.authType === "api_key"
        ? (auth.projectId ?? undefined)
        : projectId;
    const ownedWallet = authorizedCustodyWalletId
      ? await targets.findOperationalWalletById({
          organizationId: actor.organizationId,
          projectId: lookupProjectId,
          custodyWalletId: authorizedCustodyWalletId,
        })
      : await targets.findOwnedWalletForMutation({
          organizationId: actor.organizationId,
          projectId,
          walletId: body.walletId,
        });
    if (!ownedWallet) {
      const config = await signingService.getConfigurationForMutation(
        actor.organizationId,
        projectId,
        body.provider
      );
      throw new AppError(
        "NOT_FOUND",
        config
          ? "Custody wallet not found"
          : body.provider
            ? `Custody not initialized for provider: ${body.provider}`
            : "Custody not initialized"
      );
    }
    if (ownedWallet.custodyConfigId && selectedConfig?.id !== ownedWallet.custodyConfigId) {
      throw new AppError("NOT_FOUND", "Custody wallet not found");
    }
    if (ownedWallet.custodyConnectionId) {
      if (body.provider && body.provider !== ownedWallet.provider) {
        throw badRequest("Provider does not match custody wallet");
      }
      assertCustodyProviderCanDeleteWallet(ownedWallet.provider);
      throw badRequest("Connection-owned wallet deletion is not supported");
    }

    await signingService.deleteWallet(actor.organizationId, projectId, {
      provider: body.provider,
      walletId: body.walletId,
      configId: ownedWallet.custodyConfigId,
    });

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "delete",
      resourceType: "custody_wallet",
      resourceId: body.walletId,
      metadata: {
        event: "wallet_deleted",
        walletId: body.walletId,
        provider: body.provider ?? null,
        projectId: projectId ?? null,
      },
    });

    const response: DeleteWalletResponse = {
      walletId: body.walletId,
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

export const setDefaultWallet = async (c: ValidatedBodyContext<typeof setDefaultWalletSchema>) => {
  const actor = resolveActor(c);

  const body = c.req.valid("json");

  let wallet: Awaited<ReturnType<typeof findAuthorizedOperationalWallet>>;
  try {
    wallet = await findAuthorizedOperationalWallet(c, body.walletId, ["wallets:write"]);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw badRequest("Unknown walletId for this wallet signing configuration");
    }
    throw error;
  }

  const projectId = c.get("projectId");
  if (!wallet) {
    throw badRequest("Unknown walletId for this wallet signing configuration");
  }
  if (body.provider && body.provider !== wallet.provider) {
    throw badRequest("Provider does not match custody wallet");
  }

  if (wallet.custodyConnectionId) {
    if (!isCustodyConnectionRuntimeEnabled(c.env, wallet.provider)) {
      throw new AppError("FORBIDDEN", "Custody Connection runtime is disabled");
    }
    if (!wallet.isRuntimeExecutionAllowed) {
      throw new AppError("CONFLICT", "Custody Connection is unavailable");
    }
    const updated = await getDb(c.env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, updated_at = sdp_iso_now()
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?
           AND status = 'active'
           AND EXISTS (
             SELECT 1
             FROM custody_wallets w
             WHERE w.id = ?
               AND w.custody_connection_id = custody_connections.id
               AND w.status = 'active'
           )`
      )
      .bind(wallet.id, wallet.custodyConnectionId, actor.organizationId, projectId, wallet.id)
      .run();
    if (updated !== 1) {
      throw new AppError("CONFLICT", "Custody Connection is unavailable");
    }

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "update",
      resourceType: "custody_connection",
      resourceId: wallet.custodyConnectionId,
      metadata: {
        event: "default_wallet_changed",
        provider: wallet.provider,
        walletId: wallet.walletId,
        projectId: projectId ?? null,
      },
    });
    clearWalletCaches();
    return success(c, { defaultWalletId: wallet.walletId });
  }

  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));
  const config = await signingService.getConfigurationForMutation(
    actor.organizationId,
    projectId,
    wallet.provider
  );

  if (!config?.id || config.id !== wallet.custodyConfigId) {
    throw new AppError("CONFLICT", "Wallet signing is not initialized");
  }

  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    actor.organizationId,
    "custody",
    config.provider
  );

  // Membership check and pointer update in one conditional statement so a
  // concurrent wallet delete/deactivate cannot slip between them.
  const updated = await getDb(c.env)
    .prepare(
      `UPDATE custody_configs
     SET default_wallet_id = ?, updated_at = datetime('now')
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM custody_wallets w
         WHERE w.custody_config_id = custody_configs.id
           AND w.wallet_id = ?
           AND w.status = 'active'
       )`
    )
    .bind(wallet.walletId, config.id, wallet.walletId)
    .run();

  if (updated === 0) {
    throw badRequest("Unknown walletId for this wallet signing configuration");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "custody_config",
    resourceId: config.id,
    metadata: {
      event: "default_wallet_changed",
      provider: config.provider,
      walletId: wallet.walletId,
      projectId: projectId ?? null,
    },
  });

  clearWalletCaches();

  return success(c, { defaultWalletId: wallet.walletId });
};

export const updateWallet = async (c: ValidatedBodyContext<typeof updateWalletSchema>) => {
  const projectId = c.get("projectId");
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }

  const body = c.req.valid("json");

  let wallet: Awaited<ReturnType<typeof findAuthorizedOperationalWallet>>;
  try {
    wallet = await findAuthorizedOperationalWallet(c, walletId, ["wallets:write"], true);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    throw error;
  }
  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found");
  }

  const nextLabel = body.label?.trim() ? body.label.trim() : null;

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
      ...wallet,
      label: nextLabel,
    },
  };

  clearWalletCaches();

  return success(c, response);
};

export const listWallets = async (c: AppContext) => {
  const filters = resolveWalletFilters(c, { defaultIncludeAllProviders: true });
  const wallets = await getWalletSummaries(c, filters, "list_wallets");
  const balancesStartedAt = performance.now();
  const balancesByWalletId = filters.includeBalances
    ? await getBalancesByWalletId(
        c,
        wallets.map((wallet) => ({
          id: wallet.id,
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
        }))
      )
    : new Map<string, CustodyWalletTokenBalance[]>();

  if (filters.includeBalances) {
    logWalletStep("list_wallets", "fetch_wallet_balances", balancesStartedAt, {
      walletCount: wallets.length,
    });
  }

  const response: CustodyWalletsResponse = {
    wallets: wallets.map((wallet) => {
      const balances = balancesByWalletId.get(wallet.id);
      return {
        ...wallet,
        ...(filters.includeBalances && balances !== undefined ? { balances } : {}),
      };
    }),
  };

  return success(c, response);
};

export const getWalletAggregate = async (c: AppContext) => {
  const filters = resolveWalletFilters(c, { defaultIncludeAllProviders: true });
  const wallets = await getWalletSummaries(c, filters, "aggregate_wallets");
  const balancesStartedAt = performance.now();
  const balancesByWalletId = await getBalancesByWalletId(
    c,
    wallets.map((wallet) => ({
      id: wallet.id,
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
    })),
    { includeUsdValues: false }
  );
  logWalletStep("aggregate_wallets", "fetch_wallet_balances", balancesStartedAt, {
    walletCount: wallets.length,
  });

  const aggregateStartedAt = performance.now();
  const aggregatedBalances = await attachUsdValuesToBalances(
    c.env,
    aggregateTrackedWalletBalances(wallets.map((wallet) => balancesByWalletId.get(wallet.id) ?? []))
  );
  logWalletStep("aggregate_wallets", "attach_usd_values", aggregateStartedAt, {
    balanceCount: aggregatedBalances.length,
  });

  const aggregate = {
    walletCount: wallets.length,
    balances: aggregatedBalances,
  };

  const response: CustodyWalletAggregateResponse = {
    aggregate,
  };

  return success(c, response);
};

export const getWalletById = async (c: AppContext) => {
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }

  let wallet: Awaited<ReturnType<typeof findAuthorizedOperationalWallet>>;
  try {
    wallet = await findAuthorizedOperationalWallet(c, walletId, ["wallets:read"], true);
  } catch (error) {
    if (error instanceof AppError && error.code === "FORBIDDEN") {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    throw error;
  }
  if (!wallet) {
    throw new AppError("NOT_FOUND", "Wallet not found");
  }

  const walletMetadata: CustodyWalletMetadataResponse["wallet"] = {
    ...wallet,
  };
  const includeBalanceQuery = c.req.query("includeBalance");
  const includeBalance = includeBalanceQuery?.trim().toLowerCase() !== "false";

  if (!includeBalance) {
    const response: CustodyWalletMetadataResponse = {
      wallet: walletMetadata,
    };
    return success(c, response);
  }

  let lamports = 0n;

  try {
    const rpc = solanaRpc.createRpc(c.env);
    const accountInfo = await solanaRpc.getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    getLogger().error(
      {
        requestId: c.get("requestId"),
        walletId: wallet.walletId,
        publicKey: wallet.publicKey,
        error: error instanceof Error ? error.message : String(error),
      },
      // biome-ignore lint/security/noSecrets: Operational log message, not a secret.
      "getWalletById: failed to fetch wallet balance"
    );
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
      ...walletMetadata,
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

  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));

  try {
    const custodyWalletId = resolveApiKeyCustodyWalletId(auth, requestedWalletId, ["wallets:read"]);
    const walletId = custodyWalletId
      ? null
      : resolveApiKeySigningWalletId(auth, requestedWalletId, ["wallets:read"]);
    if (custodyWalletId) {
      const wallet = await new CustodyRuntimeTargets(
        getDb(c.env),
        c.env,
        new Map()
      ).findOperationalWalletById({
        organizationId: actor.organizationId,
        projectId,
        custodyWalletId,
      });
      if (!wallet) {
        throw new AppError("NOT_FOUND", "Wallet not found");
      }
      return success(c, { publicKey: wallet.publicKey });
    }
    if (walletId) {
      const wallet = await new CustodyRuntimeTargets(
        getDb(c.env),
        c.env,
        new Map()
      ).findOperationalWallet({
        organizationId: actor.organizationId,
        projectId,
        walletId,
      });
      if (!wallet) {
        throw new AppError("NOT_FOUND", "Wallet not found");
      }
      if (wallet.custodyConnectionId) {
        return success(c, { publicKey: wallet.publicKey });
      }
      const publicKey = await signingService.getPublicKey(
        actor.organizationId,
        projectId,
        wallet.walletId
      );
      return success(c, { publicKey });
    }

    const effective = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).resolve({
      kind: "effective",
      organizationId: actor.organizationId,
      projectId,
    });
    if (effective?.kind === "connection") {
      const wallet = effective.wallet
        ? await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).findOperationalWallet({
            organizationId: actor.organizationId,
            projectId,
            walletId: effective.wallet.walletId,
          })
        : null;
      if (!wallet || wallet.custodyConnectionId !== effective.connectionId) {
        throw new AppError("NOT_FOUND", "Wallet not found");
      }
      return success(c, { publicKey: wallet.publicKey });
    }
    const publicKey = await signingService.getPublicKey(actor.organizationId, projectId, undefined);

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
