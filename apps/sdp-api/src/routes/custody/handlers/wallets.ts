import { SigningError } from "@sdp/custody/signing";
import { createClusterRpc } from "@sdp/rpc/factory";
import { getAccountInfo } from "@sdp/rpc/solana";
import { formatDecimalAmount } from "@sdp/solana/amount";
import {
  CUSTODY_PROVIDERS,
  type CustodyProvider,
  type CustodyWalletAggregateResponse,
  type CustodyWalletByIdResponse,
  type CustodyWalletMetadataResponse,
  type CustodyWalletResponse,
  type CustodyWalletSummary,
  type CustodyWalletsResponse,
  type CustodyWalletTokenBalance,
  type DeleteWalletResponse,
} from "@sdp/types/custody";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import type { Address } from "@solana/kit";
import { getDb } from "@/db/client";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import {
  AppError,
  badRequest,
  internalError,
  providerUnavailable,
  serviceUnavailable,
} from "@/lib/errors";
import { deriveProviderRequestId } from "@/lib/idempotency";
import { created, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { getIdempotencyClaim, markIdempotencyRecordMismatch } from "@/middleware/idempotency";
import type { RecordAnswer } from "@/middleware/movement-steps";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, parseBooleanQueryParam, resolveActor } from "@/routes/custody/context";
import type {
  createWalletSchema,
  deleteWalletSchema,
  updateWalletSchema,
} from "@/routes/custody/schemas";
import {
  clearWalletBalanceCache,
  readWalletBalances,
  type WalletBalanceTarget,
} from "@/routes/custody/wallet-balances";
import { withIssuedTokenLabels } from "@/routes/payments/token-accounts";
import { resolveIssuedTokenLabelsByMint } from "@/routes/payments/token-labels";
import { getLogger } from "@/runtime/logger";
import { AuditService } from "@/services/audit.service";
import { assertCustodyProviderCanDeleteWallet } from "@/services/custody-provider-lifecycle.service";
import {
  CustodyRuntimeTargets,
  type CustodyRuntimeWalletProjection,
} from "@/services/domain/signing/custody-runtime-target";
import * as signingServiceModule from "@/services/domain/signing.service";
import {
  aggregateTrackedWalletBalances,
  attachTokenSymbolsToBalanceMap,
  attachUsdValuesToBalanceMap,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { assertCustodyProviderAvailable } from "@/services/provider-availability.service";
import type { CustodyWalletIdempotency } from "@/services/stores/custody-config.store";

export function clearWalletCaches() {
  clearWalletBalanceCache();
}

function buildWalletBalanceCacheScope(c: AppContext): string {
  const auth = getAuth(c);
  return `${auth.organizationId}:${requireProjectId(c)}`;
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
  const { walletAccess } = getAuth(c);
  if (walletAccess.scope === "selected" && walletAccess.custodyWalletIds.length === 0) {
    return [];
  }
  const actor = resolveActor(c);
  const wallets = await new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).listWallets({
    organizationId: actor.organizationId,
    projectId: filters.projectId,
    provider: filters.provider,
  });
  // The wallet list is one of the two reads a selected key's list narrows
  // (HOO-2099); every other read is project-scoped.
  return wallets.filter((wallet) => walletAccessAllows(walletAccess, wallet.id));
}

/**
 * The project's operational wallet a path parameter names (provider wallet id,
 * or, with `allowRecordIdAlias`, the custody wallet id). Project-scoped:
 * whether a key may sign with it is the custody signer's decision (HOO-2099).
 */
export async function findProjectOperationalWallet(
  c: AppContext,
  walletId: string,
  allowRecordIdAlias = false
) {
  const actor = resolveActor(c);
  return new CustodyRuntimeTargets(getDb(c.env), c.env, new Map()).findOperationalWallet({
    organizationId: actor.organizationId,
    projectId: requireProjectId(c),
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

function resolveWalletFilters(c: AppContext) {
  const projectId = requireProjectId(c);
  const providerQuery = c.req.query("provider");
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
  };
}

async function getBalancesByWalletId(
  c: AppContext,
  walletPublicKeys: WalletBalanceTarget[],
  options: { includeUsdValues?: boolean } = {}
) {
  // Labels and chain reads start together; neither needs the other until both are in.
  const [tokenLabelsByMint, observedBalances] = await Promise.all([
    resolveIssuedTokenLabelsByMint(c),
    readWalletBalances(
      createClusterRpc(),
      buildWalletBalanceCacheScope(c),
      walletPublicKeys,
      c.get("requestId")
    ),
  ]);
  const labeledBalances = new Map(
    [...observedBalances].map(([walletId, balances]) => [
      walletId,
      withIssuedTokenLabels(balances, tokenLabelsByMint),
    ])
  );

  const balancesMap = await attachTokenSymbolsToBalanceMap(labeledBalances);

  if (options.includeUsdValues === false) {
    return balancesMap;
  }

  return attachUsdValuesToBalanceMap(c.env, balancesMap);
}

/**
 * The provider request id a wallet create's Idempotency-Key stands for
 * (HOO-1918). Scoped by organization, project and credential, so the same
 * client key from another tenant or credential never reaches a provider, or
 * the row's unique index, as the same request.
 */
export function deriveCustodyWalletCreateRequestId(
  scope: { organizationId: string; projectId: string; principal: string },
  idempotencyKey: string
): string {
  return deriveProviderRequestId(
    ["custody_wallet_create", scope.organizationId, scope.projectId, scope.principal],
    idempotencyKey
  );
}

/**
 * A keyed create's recovery point (migration 0136): only when the shared step
 * claimed a key for this request; null without one.
 */
function custodyWalletIdempotency(c: AppContext): CustodyWalletIdempotency | null {
  const claim = getIdempotencyClaim(c);
  if (claim === undefined) return null;
  const auth = getAuth(c);
  return {
    requestId: deriveCustodyWalletCreateRequestId(
      { organizationId: auth.organizationId, projectId: requireProjectId(c), principal: auth.id },
      claim.key
    ),
    fingerprint: claim.fingerprint,
  };
}

interface KeyedCustodyWalletRow {
  id: string;
  custody_config_id: string | null;
  custody_connection_id: string | null;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: string | null;
  status: "active" | "inactive";
  created_at: string;
  idempotency_fingerprint: string | null;
}

/**
 * Answers a wallet create whose Idempotency-Key already made a wallet, from
 * its row (HOO-1918): after a crash between the row and the stored response, a
 * lease takeover, or past the key's 24 hours. The provider is not called. The
 * same key with a different request is refused (422). Reads one row only.
 */
export async function findCustodyWalletCreateReplay(c: AppContext): Promise<RecordAnswer | null> {
  const idempotency = custodyWalletIdempotency(c);
  if (idempotency === null) return null;
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  // The request id already binds the tenant and credential; `replayFromRecord`
  // compares the fingerprint, which is the request.
  const row = await getDb(c.env)
    .prepare(
      `SELECT w.id, w.custody_config_id, w.custody_connection_id, w.wallet_id, w.public_key,
              w.label, w.purpose, w.status, w.created_at, w.idempotency_fingerprint
       FROM custody_wallets w
       LEFT JOIN custody_configs cc ON cc.id = w.custody_config_id
       LEFT JOIN custody_connections cn ON cn.id = w.custody_connection_id
       WHERE w.idempotency_request_id = ?
         AND COALESCE(cc.organization_id, cn.organization_id) = ?
         AND COALESCE(cc.project_id, cn.project_id) = ?
       LIMIT 1`
    )
    .bind(idempotency.requestId, auth.organizationId, projectId)
    .first<KeyedCustodyWalletRow>();
  if (row === null || row.idempotency_fingerprint === null) return null;
  // custody_wallets_exactly_one_owner (0046): a row has a config or a connection.
  let owner: { custodyConfigId: string } | { custodyConnectionId: string };
  if (row.custody_config_id !== null) {
    owner = { custodyConfigId: row.custody_config_id };
  } else if (row.custody_connection_id !== null) {
    owner = { custodyConnectionId: row.custody_connection_id };
  } else {
    throw internalError("Custody wallet row has no owner");
  }
  const response: CustodyWalletResponse = {
    wallet: {
      ...owner,
      id: row.id,
      isRuntimeExecutionAllowed: true,
      walletId: row.wallet_id,
      publicKey: row.public_key,
      label: row.label,
      purpose: row.purpose,
      status: row.status,
      createdAt: row.created_at,
    },
  };
  return { fingerprint: row.idempotency_fingerprint, respond: () => created(c, response) };
}

export const createWallet = async (c: ValidatedBodyContext<typeof createWalletSchema>) => {
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  const body = c.req.valid("json");
  const idempotency = custodyWalletIdempotency(c);

  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));

  try {
    if (body.connectionId !== undefined) {
      const wallet = await new CustodyRuntimeTargets(
        getDb(c.env),
        c.env,
        new Map()
      ).createConnectionWallet({
        auditContext: c,
        creationReason: "wallet_api",
        organizationId: actor.organizationId,
        projectId,
        connectionId: body.connectionId,
        label: body.label,
        purpose: body.purpose,
        idempotency,
      });
      clearWalletCaches();
      return created(c, { wallet } satisfies CustodyWalletResponse);
    }

    const wallet = await signingService.createWallet(actor.organizationId, projectId, {
      provider: body.provider,
      label: body.label,
      purpose: body.purpose,
      idempotency,
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
    if (idempotency !== null && isPostgresUniqueViolation(error)) {
      // A concurrent attempt under this key recorded the wallet first: answer from its row.
      const replay = await findCustodyWalletCreateReplay(c);
      if (replay !== null) {
        if (replay.fingerprint !== idempotency.fingerprint) {
          // Another request's row: refused unstored, so that request's own retry
          // is still answered from it.
          markIdempotencyRecordMismatch(c);
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        }
        return replay.respond();
      }
    }
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", error.message);
      }
      if (error.code === "INVALID_REQUEST") {
        throw badRequest(error.message);
      }
      // The provider or the wallet's persistence failed: a 503, stored under the
      // key like the BYOK path's.
      throw providerUnavailable("Custody provider is temporarily unavailable");
    }
    throw error;
  }
};

export const deleteWallet = async (c: ValidatedBodyContext<typeof deleteWalletSchema>) => {
  const actor = resolveActor(c);

  const body = c.req.valid("json");

  const projectId = requireProjectId(c);
  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));

  try {
    const targets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());
    const ownedWallet = await targets.findOwnedWalletForMutation({
      organizationId: actor.organizationId,
      projectId,
      walletId: body.walletId,
    });
    if (!ownedWallet) {
      throw new AppError("NOT_FOUND", "Custody wallet not found");
    }
    if (ownedWallet.custodyConfigId === undefined) {
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
        projectId,
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

export const updateWallet = async (c: ValidatedBodyContext<typeof updateWalletSchema>) => {
  const projectId = requireProjectId(c);
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }

  const body = c.req.valid("json");

  const wallet = await findProjectOperationalWallet(c, walletId, true);
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
      projectId,
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
  const filters = resolveWalletFilters(c);
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
  const filters = resolveWalletFilters(c);
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

  const walletBalances = wallets.map((wallet) => {
    const balances = balancesByWalletId.get(wallet.id);
    if (balances === undefined) {
      throw serviceUnavailable("Wallet balances are temporarily unavailable. Try again.");
    }
    return balances;
  });
  const aggregateStartedAt = performance.now();
  const aggregatedBalances = await attachUsdValuesToBalances(
    c.env,
    aggregateTrackedWalletBalances(walletBalances)
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

  const wallet = await findProjectOperationalWallet(c, walletId, true);
  // A wallet detail read: a selected key opens only the wallets it lists.
  if (!wallet || !walletAccessAllows(getAuth(c).walletAccess, wallet.id)) {
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

  let lamports: bigint;
  try {
    const rpc = createClusterRpc();
    const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);
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
    throw providerUnavailable("Wallet balance is temporarily unavailable. Try again.");
  }

  const solBalance = {
    token: "SOL" as const,
    mint: SOL_MINT,
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

/**
 * Refuses a persisted wallet whose (provider, custody mode) pair the release channel
 * leaves out, for read paths that answer from the wallet row and build no adapter.
 * A Connection wallet is BYOK custody, a Config wallet Managed.
 *
 * @param c - Request context carrying the release channel.
 * @param wallet - The operational wallet about to be answered from.
 * @throws 403 when the pair is outside the release channel.
 */
function assertWalletInReleaseChannel(c: AppContext, wallet: CustodyRuntimeWalletProjection): void {
  assertCustodyProviderAvailable(
    c.env,
    wallet.provider,
    wallet.custodyConnectionId ? "byok" : "managed"
  );
}

export const getPublicKey = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const requestedWalletId = c.req.query("walletId");

  const signingService = signingServiceModule.createSigningService(c.env, getRequestTenantScope(c));
  const runtimeTargets = new CustodyRuntimeTargets(getDb(c.env), c.env, new Map());

  try {
    const walletId = requestedWalletId?.trim();
    if (!walletId) {
      throw badRequest("walletId is required");
    }
    const wallet = await runtimeTargets.findOperationalWallet({
      organizationId: actor.organizationId,
      projectId,
      walletId,
    });
    // A wallet detail read: a selected key sees only the wallets it lists.
    if (!wallet || !walletAccessAllows(auth.walletAccess, wallet.id)) {
      throw new AppError("NOT_FOUND", "Wallet not found");
    }
    if (wallet.custodyConnectionId) {
      assertWalletInReleaseChannel(c, wallet);
      return success(c, { publicKey: wallet.publicKey });
    }
    const publicKey = await signingService.getPublicKey(
      actor.organizationId,
      projectId,
      wallet.walletId
    );
    return success(c, { publicKey });
  } catch (error) {
    if (error instanceof SigningError) {
      throw new AppError("NOT_FOUND", "No signing key configured for this organization");
    }
    throw error;
  }
};
