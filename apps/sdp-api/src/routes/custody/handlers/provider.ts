import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { clearWalletCaches } from "@/routes/custody/handlers/wallets";
import { AuditService } from "@/services/audit.service";
import type { CustodyProvider } from "@/services/custody/providers";
import { CUSTODY_PROVIDERS } from "@/services/custody/providers";
import { provisionFireblocksVaultAccount } from "@/services/custody/provisioning";
import { normalizePem } from "@/services/custody/provisioning.common";
import {
  type FireblocksProviderConfig,
  parseConfigRecord,
} from "@/services/domain/signing/provider-config";
import { createSigningService } from "@/services/domain/signing.service";
import { SigningError } from "@/services/ports";
import {
  assertProviderAvailable,
  getEnabledProviders,
} from "@/services/provider-availability.service";
import { type AppContext, getPreferredWalletForConfig, resolveActor } from "../context";
import {
  type InitializeSigningRequest,
  type InitializeSigningResponse,
  initializeSigningSchema,
  type SwitchProviderOptionsResponse,
  type SwitchSigningRequest,
  switchSigningSchema,
} from "../schemas";

type SigningInitializationResult = {
  configId: string;
  publicKey: string;
  walletId: string;
};

export const initializeSigning = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.get("projectId");

  const body = await c.req.json();
  const parsed = initializeSigningSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);

  try {
    await assertProviderAvailable(
      c.env,
      getDb(c.env),
      actor.organizationId,
      "custody",
      parsed.data.provider
    );

    const result = await initializeProviderConnection(
      c,
      signingService,
      c.env,
      actor.organizationId,
      await resolveOrganizationSlug(c, actor.organizationId),
      projectId,
      parsed.data
    );

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "custody_config",
      resourceId: result.configId,
      metadata: {
        event: "provider_connected",
        provider: parsed.data.provider,
        projectId: projectId ?? null,
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
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const signingService = createSigningService(c.env);
  const auditService = new AuditService(getDb(c.env));
  const projectId = c.get("projectId");
  const targetProvider = parsed.data.provider;

  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    actor.organizationId,
    "custody",
    targetProvider
  );

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
        getDb(c.env),
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
        c,
        signingService,
        c.env,
        actor.organizationId,
        await resolveOrganizationSlug(c, actor.organizationId),
        projectId,
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
  const projectId = c.get("projectId");
  const signingService = createSigningService(c.env);
  const enabledProviders = (await getEnabledProviders(c.env, getDb(c.env), actor.organizationId))
    .custody;
  const [reuseState, configurations] = await Promise.all([
    signingService.getProviderReuseState(actor.organizationId, projectId),
    signingService.getConfigurations(actor.organizationId, projectId),
  ]);

  const activeProviders = new Set(configurations.configs.map((config) => config.provider));
  const defaultProvider =
    configurations.configs.find((config) => config.id === configurations.defaultConfigId)
      ?.provider ?? null;

  const response: SwitchProviderOptionsResponse = {
    providers: CUSTODY_PROVIDERS.filter((provider) => enabledProviders.includes(provider)).map(
      (provider) => {
        const hasReusableWallet =
          provider === "privy"
            ? reuseState.privy
            : provider === "coinbase_cdp"
              ? reuseState.coinbase_cdp
              : provider === "para"
                ? reuseState.para
                : provider === "turnkey"
                  ? reuseState.turnkey
                  : provider === "utila"
                    ? reuseState.utila
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
      }
    ),
  };

  return success(c, response);
};

async function initializeProviderConnection(
  c: AppContext,
  signingService: ReturnType<typeof createSigningService>,
  env: AppContext["env"],
  organizationId: string,
  organizationSlug: string,
  projectId: string | undefined,
  request: InitializeSigningRequest | SwitchSigningRequest
): Promise<SigningInitializationResult> {
  switch (request.provider) {
    case "local":
      return signingService.initializeLocalSigning(organizationId, projectId, {
        walletLabel: request.walletLabel,
      });
    case "fireblocks": {
      if (!env.FIREBLOCKS_API_KEY || !env.FIREBLOCKS_API_SECRET) {
        throw badRequest("Fireblocks backend credentials are not configured");
      }

      const resolvedApiKey = env.FIREBLOCKS_API_KEY;
      const resolvedApiSecretPem = normalizePem(env.FIREBLOCKS_API_SECRET);
      const existingFireblocksConfig = await findScopeFireblocksConfig(
        c,
        organizationId,
        projectId
      );

      const { vaultAccountId, assetId, apiBaseUrl } = existingFireblocksConfig
        ? {
            vaultAccountId: existingFireblocksConfig.vaultAccountId,
            assetId: existingFireblocksConfig.assetId,
            apiBaseUrl: existingFireblocksConfig.apiBaseUrl,
          }
        : await provisionFireblocksVaultAccount(env, {
            orgId: organizationId,
            orgSlug: organizationSlug,
            apiKey: resolvedApiKey,
            apiSecretPem: env.FIREBLOCKS_API_SECRET,
          });

      return signingService.initializeFireblocksSigning(organizationId, projectId, {
        apiKey: resolvedApiKey,
        apiSecretPem: resolvedApiSecretPem,
        vaultAccountId,
        assetId,
        apiBaseUrl,
        walletLabel: request.walletLabel,
      });
    }
    case "privy":
      return signingService.initializePrivySigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        walletLabel: request.walletLabel,
      });
    case "coinbase_cdp":
      return signingService.initializeCoinbaseCdpSigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        network: request.network,
        walletAddress: request.walletAddress,
        accountPolicy: request.accountPolicy,
        walletLabel: request.walletLabel,
      });
    case "para":
      return signingService.initializeParaSigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        walletId: request.walletId,
        walletLabel: request.walletLabel,
      });
    case "turnkey":
      return signingService.initializeTurnkeySigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        requestDelayMs: request.requestDelayMs,
        privateKeyId: request.privateKeyId,
        walletLabel: request.walletLabel,
      });
    case "dfns":
      return signingService.initializeDfnsSigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        network: request.network,
        walletId: request.walletId,
        signingKeyId: request.signingKeyId,
        walletLabel: request.walletLabel,
      });
    case "ibm_haven":
      return signingService.initializeIbmHavenSigning(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        network: request.network,
        walletId: request.walletId,
        signingKeyId: request.signingKeyId,
        walletLabel: request.walletLabel,
      });
    case "anchorage":
      return signingService.initializeAnchorageWalletLifecycle(organizationId, projectId, {
        apiBaseUrl: request.apiBaseUrl,
        walletId: request.walletId,
        walletLabel: request.walletLabel,
        network: request.network,
      });
    case "utila":
      return signingService.initializeUtilaSigning(organizationId, projectId, {
        walletLabel: request.walletLabel,
      });
    default:
      throw badRequest("Unsupported provider");
  }
}

async function findScopeConfigByProvider(
  c: AppContext,
  organizationId: string,
  projectId: string | undefined,
  provider: CustodyProvider
): Promise<{
  id: string;
  status: "active" | "inactive";
  default_wallet_id: string | null;
} | null> {
  return getDb(c.env)
    .prepare(
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
    .first<{
      id: string;
      status: "active" | "inactive";
      default_wallet_id: string | null;
    }>();
}

async function findScopeProviderConfigRecord(
  c: AppContext,
  organizationId: string,
  projectId: string | undefined,
  provider: CustodyProvider
) {
  return getDb(c.env)
    .prepare(
      projectId
        ? `SELECT id,
                organization_id,
                project_id,
                provider,
                config_encrypted AS config,
                default_wallet_id,
                status,
                created_at,
                updated_at
           FROM custody_configs
           WHERE organization_id = ? AND project_id = ? AND provider = ?
           LIMIT 1`
        : `SELECT id,
                organization_id,
                project_id,
                provider,
                config_encrypted AS config,
                default_wallet_id,
                status,
                created_at,
                updated_at
           FROM custody_configs
           WHERE organization_id = ? AND project_id IS NULL AND provider = ?
           LIMIT 1`
    )
    .bind(...(projectId ? [organizationId, projectId, provider] : [organizationId, provider]))
    .first<{
      id: string;
      organization_id: string;
      project_id: string | null;
      provider: CustodyProvider;
      config: string;
      default_wallet_id: string | null;
      status: "active" | "inactive";
      created_at: string;
      updated_at: string;
    }>();
}

async function findScopeFireblocksConfig(
  c: AppContext,
  organizationId: string,
  projectId: string | undefined
): Promise<FireblocksProviderConfig | null> {
  const record = await findScopeProviderConfigRecord(c, organizationId, projectId, "fireblocks");
  if (!record) {
    return null;
  }

  const parsed = await parseConfigRecord(c.env, organizationId, {
    id: record.id,
    organizationId: record.organization_id,
    projectId: record.project_id,
    provider: record.provider,
    config: record.config,
    defaultWalletId: record.default_wallet_id,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  });

  return parsed.provider === "fireblocks" ? parsed : null;
}

async function resolveOrganizationSlug(c: AppContext, organizationId: string): Promise<string> {
  const row = await getDb(c.env)
    .prepare("SELECT slug FROM organizations WHERE id = ? LIMIT 1")
    .bind(organizationId)
    .first<{ slug: string | null }>();

  return row?.slug?.trim() || organizationId;
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
    throw badRequest(error.message);
  }

  throw error;
}
