import { formatDecimalAmount } from "@/lib/amount";
import { assertApiKeyWalletAccess } from "@/lib/api-key-wallet-auth";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { CUSTODY_PROVIDERS, type CustodyProvider } from "@/services/custody/providers";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import { createRpc, getAccountInfo } from "@/services/solana/rpc";
import type { Address } from "@solana/kit";
import { type AppContext, parseBooleanQueryParam, resolveActor } from "../context";
import {
  type CustodyWalletByIdResponse,
  type CustodyWalletResponse,
  type CustodyWalletsResponse,
  type DeleteWalletResponse,
  createWalletSchema,
  deleteWalletSchema,
  setDefaultWalletSchema,
} from "../schemas";

// biome-ignore lint/nursery/noSecrets: Solana native mint address constant, not a secret.
const SOL_MINT = "So11111111111111111111111111111111111111112";

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

export const listWallets = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId") ?? undefined;
  const providerQuery = c.req.query("provider");
  // biome-ignore lint/nursery/noSecrets: Query parameter name, not a secret.
  const includeAllProviders = parseBooleanQueryParam(c.req.query("includeAllProviders"));

  const provider =
    providerQuery && CUSTODY_PROVIDERS.includes(providerQuery as CustodyProvider)
      ? (providerQuery as CustodyProvider)
      : undefined;

  if (providerQuery && !provider) {
    throw new AppError("BAD_REQUEST", "Invalid provider query parameter");
  }

  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWalletsWithProviders(actor.organizationId, projectId, {
    provider,
    includeAllProviders,
  });

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
    })),
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

  const rpc = createRpc(c.env);
  const accountInfo = await getAccountInfo(rpc, wallet.publicKey as Address);
  const lamports = accountInfo?.lamports ?? 0n;

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
      balance: {
        token: "SOL",
        mint: SOL_MINT,
        amount: lamports.toString(),
        uiAmount: formatDecimalAmount(lamports, 9),
        decimals: 9,
      },
    },
  };

  return success(c, response);
};

export const getPublicKey = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId");
  const walletId = c.req.query("walletId");

  const signingService = createSigningService(c.env);

  try {
    const publicKey = await signingService.getPublicKey(
      actor.organizationId,
      projectId ?? undefined,
      walletId ?? undefined
    );

    return success(c, { publicKey });
  } catch (error) {
    if (error instanceof SigningError) {
      throw new AppError("NOT_FOUND", "No signing key configured for this organization");
    }
    throw error;
  }
};
