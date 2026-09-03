import { resolveSettingsToExtensions } from "@sdp/issuance/capabilities";
import { normalizeTemplateId, resolveTemplateConfig } from "@sdp/issuance/templates";
import { getAssetTypeRegistryEntry } from "@sdp/types";
import { asTransactionalClient, getDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, internalError } from "@/lib/errors";
import {
  getSelectedSettings,
  selectedAuthorityValuedSettings,
  stampAdvancedSettingsVersion,
  validateAdvancedSettings,
} from "@/lib/issuance/advanced-settings";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { created } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import { resolveIssuanceWallet } from "../issuance/handlers/authority-resolution";
import { toPublicToken } from "../issuance/handlers/public-response";
import type { createTokenWithAssetProfileSchema } from "../issuance/schemas";
import { mapToAssetProfile } from "./handlers";

// POST /v1/issuance/asset-profiles: create token and profile in one transaction.
export const createTokenWithAssetProfile = async (
  c: ValidatedBodyContext<typeof createTokenWithAssetProfileSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const orgId = auth.organizationId;

  const body = c.req.valid("json");

  const { assetCategory, assetType, issuanceMetadata, ...tokenInput } = body;

  // Validate type early (before transaction) to avoid token insert on bad type.
  const registryEntry = getAssetTypeRegistryEntry(assetCategory, assetType);
  if (!registryEntry) {
    throw internalError("Missing registry entry for a validated asset type");
  }

  // Validate settings before touching custody or resolving extensions.
  const settingErrors = validateAdvancedSettings(assetCategory, assetType, issuanceMetadata ?? {});
  if (settingErrors.length > 0) {
    throw badRequest("Invalid advanced settings", { errors: settingErrors });
  }

  const signingWallet = tokenInput.signingCustodyWalletId
    ? await resolveIssuanceWallet({
        env: c.env,
        auth,
        custodyWalletId: tokenInput.signingCustodyWalletId,
        requiredWalletPermissions: ["tokens:write"],
      })
    : null;

  // Authority-valued settings need real wallet; reject if missing to avoid bricking.
  const authoritySettings = signingWallet
    ? []
    : selectedAuthorityValuedSettings(issuanceMetadata ?? {});
  if (authoritySettings.length > 0) {
    throw badRequest("A signing wallet is required for the selected advanced settings", {
      errors: authoritySettings.map((settingKey) => ({
        settingKey,
        reason: "signing_wallet_required",
      })),
    });
  }

  // Two mutually-exclusive extension sources: advanced settings (capability-derived
  // template, source of truth) or the legacy template + overrides. When settings are
  // present they win — `template` is a base-template hint the capability supersedes, so
  // it's tolerated (the wizard always sends it alongside settings). `overrides`, though,
  // carries explicit per-extension config that would be dropped silently; reject rather
  // than deploy something the caller never asked for (extensions are immutable post-deploy).
  const selectedSettings = getSelectedSettings(issuanceMetadata ?? {});
  const usingSettings = Object.keys(selectedSettings).length > 0;

  if (usingSettings && tokenInput.overrides !== undefined) {
    throw badRequest("Advanced settings and template overrides cannot be combined", {
      errors: [{ field: "overrides", reason: "conflicts_with_advanced_settings" }],
    });
  }

  const resolved = usingSettings
    ? resolveSettingsToExtensions(assetCategory, assetType, selectedSettings, {
        authorities: signingWallet ? { permanentDelegate: signingWallet.publicKey } : undefined,
        decimals: tokenInput.decimals,
        requiresAllowlist: tokenInput.requiresAllowlist,
      })
    : resolveTemplateConfig(
        normalizeTemplateId(tokenInput.template),
        tokenInput.overrides,
        tokenInput.requiresAllowlist,
        tokenInput.decimals
      );

  if (resolved.errors.length > 0) {
    throw badRequest("Invalid token extension configuration", { errors: resolved.errors });
  }

  const metadata = stampAdvancedSettingsVersion(issuanceMetadata ?? {});
  const publicMetadata = projectPublicMetadata(assetCategory, assetType, metadata);
  const createdBy = await resolveCreatorUserId(c);

  const db = getDb(c.env);
  const tenantScope = getRequestTenantScope(c);

  const { token, profileRow } = await db.transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const tokenService = new TokenService(client, tenantScope);
    const assetProfilesRepo = createPostgresAssetProfilesRepository(client);

    const token = await tokenService.createToken({
      projectId,
      organizationId: orgId,
      createdBy: auth.id,
      signingCustodyWalletId: signingWallet?.custodyWalletId,
      signingWalletId: signingWallet?.providerWalletId,
      name: tokenInput.name,
      symbol: tokenInput.symbol,
      decimals: resolved.decimals,
      description: tokenInput.description,
      uri: tokenInput.uri,
      imageUrl: tokenInput.imageUrl,
      template: resolved.template,
      extensions: resolved.extensions ?? undefined,
      maxSupply: tokenInput.maxSupply,
      isMintable: tokenInput.isMintable,
      isFreezable: tokenInput.isFreezable,
      requiresAllowlist: resolved.requiresAllowlist,
    });

    const profileRow = await assetProfilesRepo.createAssetProfile({
      organizationId: orgId,
      projectId,
      tokenId: token.id,
      assetCategory,
      assetType,
      assetTypeVersion: registryEntry.version,
      issuanceMetadata: metadata,
      publicMetadata,
      createdBy,
    });

    if (!profileRow) {
      // Throw to roll back token insert.
      throw internalError("Failed to create asset profile");
    }

    return { token, profileRow };
  });

  const assetProfile = mapToAssetProfile(profileRow);

  // Audit outside transaction; audit failure must not roll back committed token + profile.
  const auditService = new AuditService(db);
  await auditService.log(c, {
    action: "create",
    resourceType: "token",
    resourceId: token.id,
    metadata: {
      name: token.name,
      symbol: token.symbol,
      template: resolved.template,
    },
  });
  await auditService.log(c, {
    organizationId: orgId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "create",
    resourceType: "asset_profile",
    resourceId: assetProfile.id,
    metadata: { tokenId: token.id, assetCategory, assetType },
  });

  return created(c, { token: toPublicToken(token), assetProfile });
};
