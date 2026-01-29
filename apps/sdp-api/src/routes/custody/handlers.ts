/**
 * Custody API Handlers
 */

import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import {
  type CustodyConfigResponse,
  type CustodyWalletsResponse,
  type InitializeSigningResponse,
  initializeSigningSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

// ═══════════════════════════════════════════════════════════════════════════
// Initialize Signing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize signing for the organization.
 *
 * For "local" provider: Generates a new keypair and stores it encrypted in the database.
 * For "fireblocks" provider: Stores Fireblocks credentials and retrieves the public key.
 *
 * POST /custody/initialize
 */
export const initializeSigning = async (c: AppContext) => {
  const auth = getAuth(c);

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
        auth.organizationId,
        parsed.data.projectId,
        { walletLabel: parsed.data.walletLabel }
      );
    } else {
      result = await signingService.initializeFireblocksSigning(
        auth.organizationId,
        parsed.data.projectId,
        {
          apiKey: parsed.data.apiKey,
          apiSecretPem: parsed.data.apiSecretPem,
          vaultAccountId: parsed.data.vaultAccountId,
          assetId: parsed.data.assetId,
          apiBaseUrl: parsed.data.apiBaseUrl,
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

// ═══════════════════════════════════════════════════════════════════════════
// Get Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the current custody configuration for the organization.
 *
 * GET /custody/config
 */
export const getConfig = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);
  const config = await signingService.getConfiguration(auth.organizationId, projectId);

  if (!config) {
    throw new AppError("NOT_FOUND", "No custody configuration found for this organization");
  }

  // Get the public key from the adapter
  const publicKey = await signingService.getPublicKey(auth.organizationId, projectId ?? undefined);

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
 * List wallets for the organization's custody configuration.
 *
 * GET /custody/wallets
 */
export const listWallets = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);
  const wallets = await signingService.getWallets(auth.organizationId, projectId);

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
 * This endpoint is useful for clients that need to know the custody address
 * for constructing transactions.
 *
 * GET /custody/public-key
 */
export const getPublicKey = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);

  try {
    const publicKey = await signingService.getPublicKey(
      auth.organizationId,
      projectId ?? undefined
    );

    return success(c, { publicKey });
  } catch (error) {
    if (error instanceof SigningError) {
      throw new AppError("NOT_FOUND", "No signing key configured for this organization");
    }
    throw error;
  }
};
