import { AppError } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { clearWalletCaches } from "@/routes/custody/handlers/wallets";
import { AuditService } from "@/services/audit.service";
import { CUSTODY_PROVIDERS } from "@/services/custody/providers";
import type { CustodyProvider } from "@/services/custody/providers";
import { provisionFireblocksVaultAccount } from "@/services/custody/provisioning";
import { normalizePem } from "@/services/custody/provisioning.common";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import { type AppContext, getPreferredWalletForConfig, resolveActor } from "../context";
import {
  type InitializeSigningRequest,
  type InitializeSigningResponse,
  type SwitchProviderOptionsResponse,
  type SwitchSigningRequest,
  initializeSigningSchema,
  switchSigningSchema,
} from "../schemas";

type SigningInitializationResult = {
  configId: string;
  publicKey: string;
  walletId: string;
};

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
    const result = await initializeProviderConnection(
      signingService,
      c.env,
      actor.organizationId,
      parsed.data
    );

    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "create",
      resourceType: "custody_config",
      resourceId: result.configId,
      metadata: {
        event: "provider_connected",
        provider: parsed.data.provider,
        projectId: parsed.data.projectId ?? null,
      },
    });

    clearWalletCaches();

    return created(c, toInitializeSigningResponse(result));
  } catch (error) {
    handleSigningInitializationError(error);
  }
};

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
  const auditService = new AuditService(c.env.DB);
  const projectId = parsed.data.projectId;
  const targetProvider = parsed.data.provider;

  const existingScopeConfig = await findScopeConfigByProvider(
    c,
    actor.organizationId,
    projectId,
    targetProvider
  );

  try {
    let result: SigningInitializationResult;

    if (existingScopeConfig?.status === "active") {
      await signingService.setDefaultConfiguration(
        actor.organizationId,
        projectId,
        existingScopeConfig.id
      );

      const preferredWallet = await getPreferredWalletForConfig(
        c.env.DB,
        existingScopeConfig.id,
        existingScopeConfig.default_wallet_id
      );
      if (!preferredWallet) {
        throw new AppError("CONFLICT", "Active provider is missing an active wallet");
      }

      result = {
        configId: existingScopeConfig.id,
        publicKey: preferredWallet.publicKey,
        walletId: preferredWallet.walletId,
      };

      await logDefaultProviderChanged(c, auditService, existingScopeConfig.id, {
        projectId,
        provider: targetProvider,
      });
    } else {
      result = await initializeProviderConnection(
        signingService,
        c.env,
        actor.organizationId,
        parsed.data
      );

      await signingService.setDefaultConfiguration(
        actor.organizationId,
        projectId,
        result.configId
      );

      const wasReactivated =
        existingScopeConfig?.status === "inactive" && existingScopeConfig.id === result.configId;

      await auditService.log(c, {
        action: wasReactivated ? "update" : "create",
        resourceType: "custody_config",
        resourceId: result.configId,
        metadata: {
          event: wasReactivated ? "provider_reactivated" : "provider_connected",
          provider: targetProvider,
          projectId: projectId ?? null,
        },
      });

      await logDefaultProviderChanged(c, auditService, result.configId, {
        projectId,
        provider: targetProvider,
      });
    }

    clearWalletCaches();

    return created(c, toInitializeSigningResponse(result));
  } catch (error) {
    handleSigningInitializationError(error);
  }
};

export const getSwitchProviderOptions = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId") ?? actor.projectId;
  const signingService = createSigningService(c.env);
  const [reuseState, configurations] = await Promise.all([
    signingService.getProviderReuseState(actor.organizationId, projectId),
    signingService.getConfigurations(actor.organizationId, projectId),
  ]);

  const activeProviders = new Set(configurations.configs.map((config) => config.provider));
  const defaultProvider =
    configurations.configs.find((config) => config.id === configurations.defaultConfigId)
      ?.provider ?? null;

  const response: SwitchProviderOptionsResponse = {
    providers: CUSTODY_PROVIDERS.map((provider) => {
      const hasReusableWallet =
        provider === "privy"
          ? reuseState.privy
          : provider === "coinbase_cdp"
            ? reuseState.coinbase_cdp
            : provider === "para"
              ? reuseState.para
              : provider === "turnkey"
                ? reuseState.turnkey
                : false;

      const needsWalletLabel =
        provider === "fireblocks" ? false : provider === "local" ? true : !hasReusableWallet;

      return {
        provider,
        hasReusableWallet,
        needsWalletLabel,
        isActive: activeProviders.has(provider),
        isDefault: defaultProvider === provider,
      };
    }),
  };

  return success(c, response);
};

async function initializeProviderConnection(
  signingService: ReturnType<typeof createSigningService>,
  env: AppContext["env"],
  organizationId: string,
  request: InitializeSigningRequest | SwitchSigningRequest
): Promise<SigningInitializationResult> {
  switch (request.provider) {
    case "local":
      return signingService.initializeLocalSigning(organizationId, request.projectId, {
        walletLabel: request.walletLabel,
      });
    case "fireblocks": {
      if (!env.FIREBLOCKS_API_KEY || !env.FIREBLOCKS_API_SECRET) {
        throw new AppError("BAD_REQUEST", "Fireblocks backend credentials are not configured");
      }

      const resolvedApiKey = env.FIREBLOCKS_API_KEY;
      const resolvedApiSecretPem = normalizePem(env.FIREBLOCKS_API_SECRET);

      const { vaultAccountId, assetId } = await provisionFireblocksVaultAccount(env, {
        orgId: organizationId,
        orgSlug: organizationId,
        apiKey: resolvedApiKey,
        apiSecretPem: resolvedApiSecretPem,
      });

      return signingService.initializeFireblocksSigning(organizationId, request.projectId, {
        apiKey: resolvedApiKey,
        apiSecretPem: resolvedApiSecretPem,
        vaultAccountId,
        assetId,
        walletLabel: request.walletLabel,
      });
    }
    case "privy":
      return signingService.initializePrivySigning(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        walletLabel: request.walletLabel,
      });
    case "coinbase_cdp":
      return signingService.initializeCoinbaseCdpSigning(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        network: request.network,
        walletAddress: request.walletAddress,
        accountPolicy: request.accountPolicy,
        walletLabel: request.walletLabel,
      });
    case "para":
      return signingService.initializeParaSigning(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        walletId: request.walletId,
        walletLabel: request.walletLabel,
      });
    case "turnkey":
      return signingService.initializeTurnkeySigning(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        privateKeyId: request.privateKeyId,
        walletLabel: request.walletLabel,
      });
    case "dfns":
      return signingService.initializeDfnsSigning(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        network: request.network,
        walletId: request.walletId,
        signingKeyId: request.signingKeyId,
        walletLabel: request.walletLabel,
      });
    case "anchorage":
      return signingService.initializeAnchorageWalletLifecycle(organizationId, request.projectId, {
        apiBaseUrl: request.apiBaseUrl,
        walletId: request.walletId,
        walletLabel: request.walletLabel,
        network: request.network,
      });
    default:
      throw new AppError("BAD_REQUEST", "Unsupported provider");
  }
}

async function findScopeConfigByProvider(
  c: AppContext,
  organizationId: string,
  projectId: string | undefined,
  provider: CustodyProvider
): Promise<{ id: string; status: "active" | "inactive"; default_wallet_id: string | null } | null> {
  return c.env.DB.prepare(
    projectId
      ? `SELECT id, status, default_wallet_id
           FROM custody_configs
           WHERE organization_id = ? AND project_id = ? AND provider = ?
           LIMIT 1`
      : `SELECT id, status, default_wallet_id
           FROM custody_configs
           WHERE organization_id = ? AND project_id IS NULL AND provider = ?
           LIMIT 1`
  )
    .bind(...(projectId ? [organizationId, projectId, provider] : [organizationId, provider]))
    .first<{ id: string; status: "active" | "inactive"; default_wallet_id: string | null }>();
}

async function logDefaultProviderChanged(
  c: AppContext,
  auditService: AuditService,
  resourceId: string,
  params: {
    projectId: string | undefined;
    provider: CustodyProvider;
  }
): Promise<void> {
  await auditService.log(c, {
    action: "update",
    resourceType: "custody_config",
    resourceId,
    metadata: {
      event: "default_provider_changed",
      provider: params.provider,
      projectId: params.projectId ?? null,
    },
  });
}

function toInitializeSigningResponse(
  result: SigningInitializationResult
): InitializeSigningResponse {
  return {
    configId: result.configId,
    publicKey: result.publicKey,
    walletId: result.walletId,
  };
}

function handleSigningInitializationError(error: unknown): never {
  if (error instanceof SigningError) {
    if (error.code === "ALREADY_INITIALIZED") {
      throw new AppError("CONFLICT", error.message);
    }
    throw new AppError("BAD_REQUEST", error.message);
  }

  throw error;
}
