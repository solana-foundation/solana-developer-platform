/**
 * Wallet API Handlers
 */

import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import {
  type CustodyConfigResponse,
  type CustodyWalletResponse,
  type CustodyWalletsResponse,
  type InitializeSigningResponse,
  createWalletSchema,
  initializeSigningSchema,
  setDefaultWalletSchema,
  switchSigningSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function resolveActor(c: AppContext): { organizationId: string } {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { organizationId: apiKey.organizationId };
  }

  const clerk = c.get("clerk");
  if (clerk) {
    return { organizationId: clerk.organizationId };
  }

  const session = c.get("session");
  if (session) {
    return { organizationId: session.organizationId };
  }

  throw new AppError("UNAUTHORIZED", "Authentication required");
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialize Signing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize signing for the organization.
 *
 * For "local" provider: Generates a new keypair and stores it encrypted in the database.
 * For "fireblocks" provider: Stores Fireblocks credentials and retrieves the public key.
 * For "privy" provider: Stores Privy credentials and retrieves the public key.
 *
 * POST /wallets/initialize
 */
export const initializeSigning = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = initializeSigningSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);

  try {
    let result: { configId: string; publicKey: string; walletId: string };

    if (parsed.data.provider === "local") {
      result = await signingService.initializeLocalSigning(
        actor.organizationId,
        parsed.data.projectId,
        { walletLabel: parsed.data.walletLabel }
      );
    } else if (parsed.data.provider === "fireblocks") {
      result = await signingService.initializeFireblocksSigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiKey: parsed.data.apiKey,
          apiSecretPem: parsed.data.apiSecretPem,
          vaultAccountId: parsed.data.vaultAccountId,
          assetId: parsed.data.assetId,
          apiBaseUrl: parsed.data.apiBaseUrl,
        }
      );
    } else {
      result = await signingService.initializePrivySigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          requestDelayMs: parsed.data.requestDelayMs,
          walletLabel: parsed.data.walletLabel,
        }
      );
    }

    const response: InitializeSigningResponse = {
      configId: result.configId,
      publicKey: result.publicKey,
      walletId: result.walletId,
    };

    return created(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      if (error.code === "ALREADY_INITIALIZED") {
        throw new AppError("CONFLICT", error.message);
      }
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

/**
 * Switch the signing provider for the organization (or project).
 *
 * This deactivates the existing active wallet signing config for the requested scope and then
 * initializes the requested provider. Existing on-chain authorities are NOT rotated.
 *
 * POST /wallets/switch
 */
export const switchSigning = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = switchSigningSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);

  // Deactivate any active config for the requested scope so initialize* does not conflict.
  const projectId = parsed.data.projectId;
  if (projectId) {
    await c.env.DB.prepare(
      `UPDATE custody_configs
       SET status = 'inactive', updated_at = datetime('now')
      WHERE organization_id = ? AND project_id = ? AND status = 'active'`
    )
      .bind(actor.organizationId, projectId)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE custody_configs
       SET status = 'inactive', updated_at = datetime('now')
       WHERE organization_id = ? AND project_id IS NULL AND status = 'active'`
    )
      .bind(actor.organizationId)
      .run();
  }

  try {
    let result: { configId: string; publicKey: string; walletId: string };

    if (parsed.data.provider === "local") {
      result = await signingService.initializeLocalSigning(actor.organizationId, projectId, {
        walletLabel: parsed.data.walletLabel,
      });
    } else if (parsed.data.provider === "fireblocks") {
      result = await signingService.initializeFireblocksSigning(actor.organizationId, projectId, {
        apiKey: parsed.data.apiKey,
        apiSecretPem: parsed.data.apiSecretPem,
        vaultAccountId: parsed.data.vaultAccountId,
        assetId: parsed.data.assetId,
        apiBaseUrl: parsed.data.apiBaseUrl,
      });
    } else {
      result = await signingService.initializePrivySigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        requestDelayMs: parsed.data.requestDelayMs,
        walletLabel: parsed.data.walletLabel,
      });
    }

    const response: InitializeSigningResponse = {
      configId: result.configId,
      publicKey: result.publicKey,
      walletId: result.walletId,
    };

    return created(c, response);
  } catch (error) {
    if (error instanceof SigningError) {
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Create Wallet
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provision a new wallet for the organization (or project).
 *
 * POST /wallets
 */
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
        throw new AppError("CONFLICT", error.message);
      }
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Set Default Wallet
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set the default wallet for the active wallet signing configuration.
 *
 * POST /wallets/default-wallet
 */
export const setDefaultWallet = async (c: AppContext) => {
  const actor = resolveActor(c);

  const body = await c.req.json();
  const parsed = setDefaultWalletSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectId = parsed.data.projectId ?? null;
  const config = await c.env.DB.prepare(
    projectId
      ? `SELECT id FROM custody_configs
         WHERE organization_id = ? AND project_id = ? AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 1`
      : `SELECT id FROM custody_configs
         WHERE organization_id = ? AND project_id IS NULL AND status = 'active'
         ORDER BY updated_at DESC
         LIMIT 1`
  )
    .bind(...(projectId ? [actor.organizationId, projectId] : [actor.organizationId]))
    .first<{ id: string }>();

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

  return success(c, { defaultWalletId: parsed.data.walletId });
};

// ═══════════════════════════════════════════════════════════════════════════
// Get Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the current wallet signing configuration for the organization.
 *
 * GET /wallets/config
 */
export const getConfig = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);
  const config = await signingService.getConfiguration(actor.organizationId, projectId);

  if (!config) {
    throw new AppError("NOT_FOUND", "No wallet signing configuration found for this organization");
  }

  // Get the public key from the adapter
  const publicKey = await signingService.getPublicKey(actor.organizationId, projectId ?? undefined);

  const response: CustodyConfigResponse = {
    config: {
      id: config.id,
      organizationId: config.organizationId,
      projectId: config.projectId,
      provider: config.provider,
      publicKey,
      defaultWalletId: config.defaultWalletId,
      status: config.status,
      createdAt: config.createdAt,
    },
  };

  return success(c, response);
};

// ═══════════════════════════════════════════════════════════════════════════
// List Wallets
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List wallets for the organization's active signing configuration.
 *
 * GET /wallets
 */
export const listWallets = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWallets(actor.organizationId, projectId);

  const response: CustodyWalletsResponse = {
    wallets: wallets.map((w) => ({
      id: w.id,
      walletId: w.walletId,
      publicKey: w.publicKey,
      label: w.label,
      purpose: w.purpose,
      status: w.status,
      createdAt: w.createdAt,
    })),
  };

  return success(c, response);
};

// ═══════════════════════════════════════════════════════════════════════════
// Get Public Key
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the public key for the organization's signing wallet.
 *
 * This endpoint is useful for clients that need to know the wallet address
 * for constructing transactions.
 *
 * GET /wallets/public-key
 */
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
