import { formatDecimalAmount } from "@/lib/amount";
import {
  assertApiKeyWalletAccess,
  filterApiKeyWallets,
  resolveApiKeySigningWalletId,
} from "@/lib/api-key-wallet-auth";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { SOL_MINT, getSplTokenBalances } from "@/routes/payments/token-accounts";
import { AuditService } from "@/services/audit.service";
import { CUSTODY_PROVIDERS, type CustodyProvider } from "@/services/custody/providers";
import { createSigningService } from "@/services/domain/signing.service";
import {
  aggregateTrackedWalletBalances,
  attachUsdValuesToBalanceMap,
  attachUsdValuesToBalances,
} from "@/services/helius-das.service";
import { SigningError } from "@/services/ports";
import { createRpc, getAccountInfo } from "@/services/solana/rpc";
import type { CustodyWalletTokenBalance } from "@sdp/types";
import type { Address } from "@solana/kit";
import { type AppContext, parseBooleanQueryParam, resolveActor } from "../context";
import {
  type CustodyWalletAggregateResponse,
  type CustodyWalletByIdResponse,
  type CustodyWalletResponse,
  type CustodyWalletsResponse,
  type DeleteWalletResponse,
  createWalletSchema,
  deleteWalletSchema,
  setDefaultWalletSchema,
  updateWalletSchema,
} from "../schemas";

function resolveWalletFilters(
  c: AppContext,
  options: { defaultIncludeAllProviders?: boolean } = {}
) {
  const projectId = c.req.query("projectId") ?? undefined;
  const providerQuery = c.req.query("provider");
  // biome-ignore lint/nursery/noSecrets: Query parameter name, not a secret.
  const includeAllProviders = c.req.query("includeAllProviders");
  const includeBalances = parseBooleanQueryParam(c.req.query("includeBalances"));

  const provider =
    providerQuery && CUSTODY_PROVIDERS.includes(providerQuery as CustodyProvider)
      ? (providerQuery as CustodyProvider)
      : undefined;

  if (providerQuery && !provider) {
    throw new AppError("BAD_REQUEST", "Invalid provider query parameter");
  }

  return {
    projectId,
    provider,
    includeBalances,
    includeAllProviders:
      includeAllProviders === undefined
        ? options.defaultIncludeAllProviders === true
        : parseBooleanQueryParam(includeAllProviders),
  };
}

async function getScopedWallets(
  c: AppContext,
  options: { defaultIncludeAllProviders?: boolean } = {}
) {
  const auth = getAuth(c);
  const actor = resolveActor(c);
  const filters = resolveWalletFilters(c, options);
  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(
    actor.organizationId,
    filters.projectId,
    {
      provider: filters.provider,
      includeAllProviders: filters.includeAllProviders,
    }
  );

  return {
    wallets: filterApiKeyWallets(auth, wallets, ["wallets:read"]),
    filters,
  };
}

async function getBalancesByWalletId(
  c: AppContext,
  walletPublicKeys: Array<{ walletId: string; publicKey: string }>,
  options: { includeUsdValues?: boolean } = {}
) {
  const rpc = createRpc(c.env);
  const balancesByWalletId = await Promise.all(
    walletPublicKeys.map(async (wallet) => {
      let lamports = 0n;
      let splBalances: Awaited<ReturnType<typeof getSplTokenBalances>> = [];

      try {
        const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);
        lamports = accountInfo?.lamports ?? 0n;
      } catch (error) {
        // biome-ignore lint/nursery/noSecrets: Operational log message, not a secret.
        console.error("getBalancesByWalletId: failed to fetch SOL balance", {
          requestId: c.get("requestId"),
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        splBalances = await getSplTokenBalances(rpc, wallet.publicKey as Address);
      } catch (error) {
        // biome-ignore lint/nursery/noSecrets: Operational log message, not a secret.
        console.error("getBalancesByWalletId: failed to fetch SPL balances", {
          requestId: c.get("requestId"),
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const walletBalances: CustodyWalletTokenBalance[] = [
        {
          token: "SOL",
          mint: SOL_MINT,
          amount: lamports.toString(),
          uiAmount: formatDecimalAmount(lamports, 9),
          decimals: 9,
        },
        ...splBalances,
      ];

      return [wallet.walletId, walletBalances] as const;
    })
  );

  const balancesMap = new Map(balancesByWalletId);

  if (options.includeUsdValues === false) {
    return balancesMap;
  }

  return attachUsdValuesToBalanceMap(c.env, balancesMap);
}

export const createWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = createWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);

  try {
    const wallet = await signingService.createWallet(actor.organizationId, parsed.data.projectId, {
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

    return created(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND") {
        throw new AppError("NOT_FOUND", error.message);
      }
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

export const deleteWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = deleteWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectId = parsed.data.projectId ?? actor.projectId;
  const signingService = createSigningService(c.env);

  try {
    await signingService.deleteWallet(actor.organizationId, projectId, {
      provider: parsed.data.provider,
      walletId: parsed.data.walletId,
    });

    const auditService = new AuditService(c.env.DB);
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

    return success(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "NOT_FOUND" || error.code === "WALLET_NOT_FOUND") {
        throw new AppError("NOT_FOUND", error.message);
      }
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

export const setDefaultWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = setDefaultWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectId = parsed.data.projectId ?? undefined;
  const signingService = createSigningService(c.env);
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

  const wallet = await c.env.DB.prepare(
    `SELECT id
     FROM custody_wallets
     WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
     LIMIT 1`
  )
    .bind(config.id, parsed.data.walletId)
    .first<{ id: string }>();

  if (!wallet) {
    throw new AppError("BAD_REQUEST", "Unknown walletId for this wallet signing configuration");
  }

  await c.env.DB.prepare(
    `UPDATE custody_configs
     SET default_wallet_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(parsed.data.walletId, config.id)
    .run();

  const auditService = new AuditService(c.env.DB);
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

  return success(c, { defaultWalletId: parsed.data.walletId });
};

export const updateWallet = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = c.req.query("projectId") ?? actor.projectId;
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw new AppError("BAD_REQUEST", "Invalid wallet ID");
  }

  const body = await c.req.json();
  const parsed = updateWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);
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

  await c.env.DB.prepare(
    `UPDATE custody_wallets
     SET label = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  )
    .bind(nextLabel, wallet.id)
    .run();

  const auditService = new AuditService(c.env.DB);
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

  return success(c, response);
};

export const listWallets = async (c: AppContext) => {
  const { wallets, filters } = await getScopedWallets(c);
  const balancesByWalletId = filters.includeBalances
    ? await getBalancesByWalletId(
        c,
        wallets.map((wallet) => ({
          walletId: wallet.walletId,
          publicKey: wallet.publicKey,
        }))
      )
    : new Map<string, CustodyWalletTokenBalance[]>();

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
  const { wallets } = await getScopedWallets(c, { defaultIncludeAllProviders: true });
  const balancesByWalletId = await getBalancesByWalletId(
    c,
    wallets.map((wallet) => ({
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
    })),
    { includeUsdValues: false }
  );
  const aggregatedBalances = await attachUsdValuesToBalances(
    c.env,
    aggregateTrackedWalletBalances(
      wallets.map((wallet) => balancesByWalletId.get(wallet.walletId) ?? [])
    )
  );

  const response: CustodyWalletAggregateResponse = {
    aggregate: {
      walletCount: wallets.length,
      balances: aggregatedBalances,
    },
  };

  return success(c, response);
};

export const getWalletById = async (c: AppContext) => {
  const actor = resolveActor(c);
  const auth = getAuth(c);
  const projectId = c.req.query("projectId") ?? actor.projectId;
  const walletId = c.req.param("walletId")?.trim();

  if (!walletId) {
    throw new AppError("BAD_REQUEST", "Invalid wallet ID");
  }

  const signingService = createSigningService(c.env);
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
    const rpc = createRpc(c.env);
    const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);
    lamports = accountInfo?.lamports ?? 0n;
  } catch (error) {
    console.error("getWalletById: failed to fetch wallet balance", {
      requestId: c.get("requestId"),
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      error: error instanceof Error ? error.message : String(error),
    });
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
  const projectId = c.req.query("projectId");
  const requestedWalletId = c.req.query("walletId");

  const signingService = createSigningService(c.env);

  try {
    const walletId = resolveApiKeySigningWalletId(auth, requestedWalletId, ["wallets:read"]);
    const publicKey = await signingService.getPublicKey(
      actor.organizationId,
      projectId ?? undefined,
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
