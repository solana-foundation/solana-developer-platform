import { normalizePem } from "@sdp/custody/provisioning";
import { SigningError } from "@sdp/custody/signing";
import { redactCredentialString } from "@sdp/redaction";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { created } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { clearWalletCaches } from "@/routes/custody/handlers/wallets";
import { assertApiKeyNotWalletScoped } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { provisionFireblocksVaultAccount } from "@/services/custody/provisioning";
import {
  type FireblocksProviderConfig,
  parseConfigRecord,
} from "@/services/domain/signing/provider-config";
import { createSigningService } from "@/services/domain/signing.service";
import { assertCustodySetupAdmitted } from "@/services/provider-availability.service";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { type AppContext, resolveActor } from "../context";
import type {
  InitializeSigningRequest,
  InitializeSigningResponse,
  initializeSigningSchema,
} from "../schemas";

type SigningInitializationResult = {
  configId: string;
  publicKey: string;
  walletId: string;
};

export const initializeSigning = async (
  c: ValidatedBodyContext<typeof initializeSigningSchema>
) => {
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);

  // Connecting a provider creates a config and its root wallet — outside any
  // wallet-scoped key's bindings by definition.
  assertApiKeyNotWalletScoped(getAuth(c), "initialize custody providers");

  const body = c.req.valid("json");

  const signingService = createSigningService(c.env, getRequestTenantScope(c));

  try {
    const result = await initializeProviderConnection(
      c,
      signingService,
      c.env,
      actor.organizationId,
      await resolveOrganizationSlug(c, actor.organizationId),
      projectId,
      body
    );

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "custody_config",
      resourceId: result.configId,
      metadata: {
        event: "provider_connected",
        provider: body.provider,
        projectId,
      },
    });

    clearWalletCaches();

    return created(c, toInitializeSigningResponse(result));
  } catch (error) {
    handleSigningInitializationError(error);
  }
};

async function initializeProviderConnection(
  c: AppContext,
  signingService: ReturnType<typeof createSigningService>,
  env: AppContext["env"],
  organizationId: string,
  organizationSlug: string,
  projectId: string,
  request: InitializeSigningRequest
): Promise<SigningInitializationResult> {
  await assertCustodySetupAdmitted(env, getDb(env), {
    organizationId,
    projectId,
    provider: request.provider,
    mode: "managed",
  });
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

      const { vaultAccountId, assetId } = existingFireblocksConfig
        ? {
            vaultAccountId: existingFireblocksConfig.vaultAccountId,
            assetId: existingFireblocksConfig.assetId,
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
        walletLabel: request.walletLabel,
      });
    }
    case "privy":
      return signingService.initializePrivySigning(organizationId, projectId, {
        requestDelayMs: request.requestDelayMs,
        walletLabel: request.walletLabel,
      });
    case "coinbase_cdp":
      return signingService.initializeCoinbaseCdpSigning(organizationId, projectId, {
        network: request.network,
        accountPolicy: request.accountPolicy,
        walletLabel: request.walletLabel,
      });
    case "para":
      return signingService.initializeParaSigning(organizationId, projectId, {
        requestDelayMs: request.requestDelayMs,
        walletLabel: request.walletLabel,
      });
    case "turnkey":
      return signingService.initializeTurnkeySigning(organizationId, projectId, {
        requestDelayMs: request.requestDelayMs,
        walletLabel: request.walletLabel,
      });
    case "dfns":
      return signingService.initializeDfnsSigning(organizationId, projectId, {
        network: request.network,
        walletLabel: request.walletLabel,
      });
    case "ibm_haven":
      return signingService.initializeIbmHavenSigning(organizationId, projectId, {
        network: request.network,
        walletLabel: request.walletLabel,
      });
    case "anchorage":
      return signingService.initializeAnchorageWalletLifecycle(organizationId, projectId, {
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

async function findScopeFireblocksConfig(
  c: AppContext,
  organizationId: string,
  projectId: string
): Promise<FireblocksProviderConfig | null> {
  const record = await new CustodyConfigStore(getDb(c.env), c.env).findByProvider(
    organizationId,
    projectId,
    "fireblocks"
  );
  if (!record) {
    return null;
  }

  const parsed = await parseConfigRecord(c.env, organizationId, record);

  return parsed.provider === "fireblocks" ? parsed : null;
}

async function resolveOrganizationSlug(c: AppContext, organizationId: string): Promise<string> {
  const row = await getDb(c.env)
    .prepare("SELECT slug FROM organizations WHERE id = ? LIMIT 1")
    .bind(organizationId)
    .first<{ slug: string | null }>();

  return row?.slug?.trim() || organizationId;
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
      throw new AppError("CONFLICT", redactCredentialString(error.message));
    }
    if (error.code === "NETWORK_ERROR" || error.code === "PROVIDER_NOT_CONFIGURED") {
      throw badRequest("Provider setup failed. Check provider configuration and try again.");
    }
    throw badRequest(redactCredentialString(error.message));
  }

  throw error;
}
