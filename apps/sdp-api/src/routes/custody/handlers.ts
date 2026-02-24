/**
 * Wallet API Handlers
 */

import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { createFeePaymentAdapter } from "@/services/adapters/fee-payment";
import { createSigningService } from "@/services/domain/signing.service";
import { FeePaymentError, SigningError } from "@/services/ports";
import { resolveRpcTarget } from "@/services/rpc-relay.service";
import { createOrgSigner } from "@/services/solana";
import { confirmTransaction, createRpc, getRecentBlockhash } from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import type { Address } from "@solana/kit";
import {
  AccountRole,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import type { Context } from "hono";
import {
  type CustodyConfigResponse,
  type CustodyWalletResponse,
  type CustodyWalletsResponse,
  type InitializeSigningResponse,
  type SignerCheckResponse,
  type SwitchProviderOptionsResponse,
  createWalletSchema,
  initializeSigningSchema,
  setDefaultWalletSchema,
  signerCheckSchema,
  switchSigningSchema,
} from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

// biome-ignore lint/nursery/noSecrets: Solana Memo program id constant, not a secret.
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const KORA_MEMO_ALLOWED_PROGRAM_HINT =
  "Add MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr to Kora validation.allowed_programs.";

function isKoraMemoProgramPolicyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("memo") &&
    (normalized.includes("allowed list") || normalized.includes("not in the allowed list"))
  );
}

function resolveActor(c: AppContext): { organizationId: string; projectId?: string } {
  const apiKey = c.get("apiKey");
  if (apiKey) {
    return { organizationId: apiKey.organizationId, projectId: apiKey.projectId ?? undefined };
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
 * For "privy" provider: Uses platform-managed Privy credentials and provisions a wallet.
 * For "coinbase_cdp" provider: Uses platform-managed CDP credentials and provisions
 * a Solana account.
 * For "anchorage" provider: Uses platform-managed Anchorage API credentials and provisions
 * a custody wallet.
 * For "para" provider: Uses platform-managed Para credentials and provisions
 * a Solana wallet.
 * For "turnkey" provider: Uses platform-managed Turnkey credentials and provisions
 * a Solana private key.
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
    } else if (parsed.data.provider === "privy") {
      result = await signingService.initializePrivySigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          requestDelayMs: parsed.data.requestDelayMs,
          walletLabel: parsed.data.walletLabel,
        }
      );
    } else if (parsed.data.provider === "coinbase_cdp") {
      result = await signingService.initializeCoinbaseCdpSigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          network: parsed.data.network,
          walletAddress: parsed.data.walletAddress,
          accountPolicy: parsed.data.accountPolicy,
          walletLabel: parsed.data.walletLabel,
        }
      );
    } else if (parsed.data.provider === "anchorage") {
      result = await signingService.initializeAnchorageSigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          vaultId: parsed.data.vaultId,
          networkId: parsed.data.networkId,
          subaccountId: parsed.data.subaccountId,
          walletId: parsed.data.walletId,
          walletLabel: parsed.data.walletLabel,
        }
      );
    } else if (parsed.data.provider === "turnkey") {
      result = await signingService.initializeTurnkeySigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          requestDelayMs: parsed.data.requestDelayMs,
          privateKeyId: parsed.data.privateKeyId,
          walletLabel: parsed.data.walletLabel,
        }
      );
    } else if (parsed.data.provider === "para") {
      result = await signingService.initializeParaSigning(
        actor.organizationId,
        parsed.data.projectId,
        {
          apiBaseUrl: parsed.data.apiBaseUrl,
          requestDelayMs: parsed.data.requestDelayMs,
          walletId: parsed.data.walletId,
          walletLabel: parsed.data.walletLabel,
        }
      );
    } else {
      throw new AppError("BAD_REQUEST", "Unsupported custody provider");
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

  const projectId = parsed.data.projectId;
  const scopeBindings = projectId ? [actor.organizationId, projectId] : [actor.organizationId];
  const scopeClause = projectId
    ? "organization_id = ? AND project_id = ?"
    : "organization_id = ? AND project_id IS NULL";

  const activeConfigsResult = await c.env.DB.prepare(
    `SELECT id, provider
     FROM custody_configs
     WHERE ${scopeClause} AND status = 'active'
     ORDER BY updated_at DESC`
  )
    .bind(...scopeBindings)
    .all<{ id: string; provider: string }>();

  const activeConfigs = activeConfigsResult.results;
  const currentConfig = activeConfigs[0];

  if (currentConfig?.provider === parsed.data.provider) {
    throw new AppError(
      "BAD_REQUEST",
      `Provider '${parsed.data.provider}' is already active for this scope`
    );
  }

  const previousActiveConfigIds = activeConfigs.map((config) => config.id);

  // Deactivate any active config for the requested scope so initialize* does not conflict.
  if (previousActiveConfigIds.length > 0) {
    await c.env.DB.prepare(
      `UPDATE custody_configs
       SET status = 'inactive', updated_at = datetime('now')
       WHERE ${scopeClause} AND status = 'active'`
    )
      .bind(...scopeBindings)
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
    } else if (parsed.data.provider === "privy") {
      result = await signingService.initializePrivySigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        requestDelayMs: parsed.data.requestDelayMs,
        walletLabel: parsed.data.walletLabel,
      });
    } else if (parsed.data.provider === "coinbase_cdp") {
      result = await signingService.initializeCoinbaseCdpSigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        network: parsed.data.network,
        walletAddress: parsed.data.walletAddress,
        accountPolicy: parsed.data.accountPolicy,
        walletLabel: parsed.data.walletLabel,
      });
    } else if (parsed.data.provider === "anchorage") {
      result = await signingService.initializeAnchorageSigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        vaultId: parsed.data.vaultId,
        networkId: parsed.data.networkId,
        subaccountId: parsed.data.subaccountId,
        walletId: parsed.data.walletId,
        walletLabel: parsed.data.walletLabel,
      });
    } else if (parsed.data.provider === "turnkey") {
      result = await signingService.initializeTurnkeySigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        requestDelayMs: parsed.data.requestDelayMs,
        privateKeyId: parsed.data.privateKeyId,
        walletLabel: parsed.data.walletLabel,
      });
    } else if (parsed.data.provider === "para") {
      result = await signingService.initializeParaSigning(actor.organizationId, projectId, {
        apiBaseUrl: parsed.data.apiBaseUrl,
        requestDelayMs: parsed.data.requestDelayMs,
        walletId: parsed.data.walletId,
        walletLabel: parsed.data.walletLabel,
      });
    } else {
      throw new AppError("BAD_REQUEST", "Unsupported custody provider");
    }

    const response: InitializeSigningResponse = {
      configId: result.configId,
      publicKey: result.publicKey,
      walletId: result.walletId,
    };

    return created(c, response);
  } catch (error) {
    if (previousActiveConfigIds.length > 0) {
      try {
        // Ensure any partially-created new config for this scope is not left active.
        await c.env.DB.prepare(
          `UPDATE custody_configs
           SET status = 'inactive', updated_at = datetime('now')
           WHERE ${scopeClause} AND status = 'active'`
        )
          .bind(...scopeBindings)
          .run();

        const placeholders = previousActiveConfigIds.map(() => "?").join(", ");
        await c.env.DB.prepare(
          `UPDATE custody_configs
           SET status = 'active', updated_at = datetime('now')
           WHERE id IN (${placeholders})`
        )
          .bind(...previousActiveConfigIds)
          .run();
      } catch (rollbackError) {
        throw new AppError(
          "INTERNAL_ERROR",
          `Provider switch failed (${error instanceof Error ? error.message : "Unknown error"}) and rollback could not restore previous state: ${rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error"}`
        );
      }
    }

    if (error instanceof SigningError) {
      throw new AppError("BAD_REQUEST", error.message);
    }
    throw error;
  }
};

/**
 * Return provider switch options with wallet-reuse hints for UX.
 *
 * GET /wallets/switch-options
 */
export const getSwitchProviderOptions = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId") ?? actor.projectId;
  const signingService = createSigningService(c.env);
  const reuseState = await signingService.getProviderReuseState(actor.organizationId, projectId);

  const response: SwitchProviderOptionsResponse = {
    providers: [
      {
        provider: "privy",
        hasReusableWallet: reuseState.privy,
        needsWalletLabel: !reuseState.privy,
      },
      {
        provider: "coinbase_cdp",
        hasReusableWallet: reuseState.coinbase_cdp,
        needsWalletLabel: !reuseState.coinbase_cdp,
      },
      {
        provider: "anchorage",
        hasReusableWallet: reuseState.anchorage,
        needsWalletLabel: !reuseState.anchorage,
      },
      {
        provider: "para",
        hasReusableWallet: reuseState.para,
        needsWalletLabel: !reuseState.para,
      },
      {
        provider: "turnkey",
        hasReusableWallet: reuseState.turnkey,
        needsWalletLabel: !reuseState.turnkey,
      },
      {
        provider: "local",
        hasReusableWallet: false,
        needsWalletLabel: true,
      },
    ],
  };

  return success(c, response);
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

// ═══════════════════════════════════════════════════════════════════════════
// Signer Check (API key flow)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Submit a memo transaction using the wallet bound to the authenticated API key.
 *
 * This endpoint is intentionally API-key only to validate the same signer resolution
 * flow used by external integrations.
 *
 * POST /wallets/signer-check
 */
export const signerCheck = async (c: AppContext) => {
  const apiKey = c.get("apiKey");
  if (!apiKey) {
    throw new AppError("UNAUTHORIZED", "API key authentication is required");
  }

  if (!apiKey.signingWalletId) {
    throw new AppError("BAD_REQUEST", "API key is not bound to a signing wallet");
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = signerCheckSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const memo = parsed.data.memo?.trim() || `SDP signer check ${new Date().toISOString()}`;

  try {
    const signer = await createOrgSigner(
      c.env,
      apiKey.organizationId,
      apiKey.projectId ?? undefined,
      apiKey.signingWalletId
    );

    const feePayment = createFeePaymentAdapter(c.env);
    const feePayer = await feePayment.getFeePayer();

    const rpcTarget = await resolveRpcTarget({
      env: c.env,
      db: c.env.DB,
      organizationId: apiKey.organizationId,
      authProjectId: apiKey.projectId ?? null,
      requestedProjectId: null,
    });

    const rpc = createRpc(c.env, {
      rpcUrl: rpcTarget.endpoint,
      headers: rpcTarget.headers,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");

    const memoInstruction = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [{ address: signer.address, role: AccountRole.READONLY_SIGNER }],
      data: new TextEncoder().encode(memo),
    };

    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([memoInstruction], m),
      (m) => addSignersToTransactionMessage([signer], m)
    );

    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const txEncoder = getTransactionEncoder();
    const txBytes = new Uint8Array(txEncoder.encode(partiallySigned));
    const signature = await feePayment.signAndSend(txBytes);

    const confirmation = await confirmTransaction(rpc, signature, {
      commitment: "confirmed",
    });

    if (confirmation.err) {
      throw new AppError("TRANSACTION_FAILED", "Memo signer check transaction failed on-chain");
    }

    const response: SignerCheckResponse = {
      walletId: apiKey.signingWalletId,
      walletAddress: signer.address,
      feePayer,
      memo,
      signature,
      slot: Number(confirmation.slot),
      blockTime: new Date().toISOString(),
    };

    return success(c, response);
  } catch (error) {
    if (error instanceof FeePaymentError) {
      if (error.code === "RATE_LIMITED") {
        throw new AppError("RATE_LIMITED", `Kora rate limit exceeded: ${error.message}`);
      }

      if (isKoraMemoProgramPolicyError(error.message)) {
        throw new AppError(
          "BAD_REQUEST",
          `Kora rejected signer-check transaction: ${error.message}. ${KORA_MEMO_ALLOWED_PROGRAM_HINT}`
        );
      }

      throw new AppError(
        "SOLANA_RPC_ERROR",
        `Kora signer-check request failed: ${error.message}. Verify KORA_RPC_URL/KORA_API_KEY and Kora service health.`
      );
    }

    if (error instanceof SigningError) {
      throw new AppError("BAD_REQUEST", error.message);
    }

    if (error instanceof Error) {
      if (isKoraMemoProgramPolicyError(error.message)) {
        throw new AppError(
          "BAD_REQUEST",
          `Kora rejected signer-check transaction: ${error.message}. ${KORA_MEMO_ALLOWED_PROGRAM_HINT}`
        );
      }

      const message = error.message.toLowerCase();
      if (
        message.includes("kora") ||
        message.includes("fee payer") ||
        message.includes("sign and send") ||
        message.includes("internal error; reference")
      ) {
        throw new AppError(
          "SOLANA_RPC_ERROR",
          `Kora signer-check request failed: ${error.message}. Verify Kora availability and credentials.`
        );
      }
    }

    throw error;
  }
};
