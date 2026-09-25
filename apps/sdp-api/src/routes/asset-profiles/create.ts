import { resolveSettingsToExtensions } from "@sdp/issuance/capabilities";
import { normalizeTemplateId, resolveTemplateConfig } from "@sdp/issuance/templates";
import { getAssetTypeRegistryEntry } from "@sdp/types";
import type { z } from "zod";
import { asTransactionalClient, getDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, internalError, notFound } from "@/lib/errors";
import {
  getSelectedSettings,
  selectedAuthorityValuedSettings,
  stampAdvancedSettingsVersion,
  validateAdvancedSettings,
} from "@/lib/issuance/advanced-settings";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { created } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import {
  type ResolvedIssuanceWallet,
  resolveIssuanceWallet,
} from "../issuance/handlers/authority-resolution";
import {
  buildIssuanceCreateFingerprint,
  completeFailedIssuanceCreate,
  ISSUANCE_CREATE_IDEMPOTENCY_SCOPES,
  reserveIssuanceCreateRecord,
  resolveIssuanceCreateReplay,
} from "../issuance/handlers/idempotency";
import { toPublicToken } from "../issuance/handlers/public-response";
import type { createTokenWithAssetProfileSchema } from "../issuance/schemas";
import { mapToAssetProfile } from "./handlers";
import type { assetCategorySchema, assetTypeSchema, issuanceMetadataSchema } from "./schemas";

// Two mutually-exclusive extension sources: advanced settings (capability-derived
// template, source of truth) or the legacy template + overrides. When settings are
// present they win — `template` is a base-template hint the capability supersedes, so
// it's tolerated (the wizard always sends it alongside settings). `overrides`, though,
// carries explicit per-extension config that would be dropped silently; reject rather
// than deploy something the caller never asked for (extensions are immutable post-deploy).
function resolveTokenExtensions(input: {
  assetCategory: z.infer<typeof assetCategorySchema>;
  assetType: z.infer<typeof assetTypeSchema>;
  issuanceMetadata: z.infer<typeof issuanceMetadataSchema> | undefined;
  signingWallet: ResolvedIssuanceWallet | null;
  tokenInput: Pick<
    z.infer<typeof createTokenWithAssetProfileSchema>,
    "decimals" | "requiresAllowlist" | "template" | "overrides"
  >;
}) {
  const selectedSettings = getSelectedSettings(input.issuanceMetadata ?? {});
  const usingSettings = Object.keys(selectedSettings).length > 0;

  if (usingSettings && input.tokenInput.overrides !== undefined) {
    throw badRequest("Advanced settings and template overrides cannot be combined", {
      errors: [{ field: "overrides", reason: "conflicts_with_advanced_settings" }],
    });
  }

  const resolved = usingSettings
    ? resolveSettingsToExtensions(input.assetCategory, input.assetType, selectedSettings, {
        authorities: input.signingWallet
          ? { permanentDelegate: input.signingWallet.publicKey }
          : undefined,
        decimals: input.tokenInput.decimals,
        requiresAllowlist: input.tokenInput.requiresAllowlist,
      })
    : resolveTemplateConfig(
        normalizeTemplateId(input.tokenInput.template),
        input.tokenInput.overrides,
        input.tokenInput.requiresAllowlist,
        input.tokenInput.decimals
      );

  if (resolved.errors.length > 0) {
    throw badRequest("Invalid token extension configuration", { errors: resolved.errors });
  }
  return resolved;
}

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
  // template, source of truth) or the legacy template + overrides. See the
  // resolver's doc comment for the precedence rules.
  const resolved = resolveTokenExtensions({
    assetCategory,
    assetType,
    issuanceMetadata,
    signingWallet,
    tokenInput,
  });

  const metadata = stampAdvancedSettingsVersion(issuanceMetadata ?? {});
  const publicMetadata = projectPublicMetadata(assetCategory, assetType, metadata);
  const createdBy = await resolveCreatorUserId(c);

  const db = getDb(c.env);
  const tenantScope = getRequestTenantScope(c);
  const auditService = new AuditService(db);
  // The middleware already validated the shape; an absent header keeps the
  // legacy keyless behavior where every request is a new draft.
  const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER);

  const replayParams = {
    scope: ISSUANCE_CREATE_IDEMPOTENCY_SCOPES.assetProfileCreate,
    organizationId: orgId,
    projectId,
    idempotencyKey: idempotencyKey as string,
    fingerprint: buildIssuanceCreateFingerprint({
      scope: ISSUANCE_CREATE_IDEMPOTENCY_SCOPES.assetProfileCreate,
      organizationId: orgId,
      projectId,
      body,
    }),
  };

  if (idempotencyKey) {
    const replayTokenId = await resolveIssuanceCreateReplay(db, replayParams);
    if (replayTokenId) {
      return created(
        c,
        await requireReplayPair(c, replayTokenId, {
          auditService,
          assetCategory,
          assetType,
        })
      );
    }
  }

  let auditIntent: Awaited<ReturnType<AuditService["beginCritical"]>> | undefined;
  let creationCommitted = false;

  try {
    // Admit BEFORE the effect (SOLA9-195): an audit-ledger outage must fail
    // closed and leave no committed token + profile pair behind.
    auditIntent = await auditService.beginCritical(c, {
      action: "create",
      resourceType: "token",
      metadata: {
        name: tokenInput.name,
        symbol: tokenInput.symbol,
        template: resolved.template,
        assetCategory,
        assetType,
      },
    });

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

      if (idempotencyKey) {
        // Same transaction as the token insert: a retry of a committed
        // admission can only replay it, never create a second draft.
        await reserveIssuanceCreateRecord(client, {
          ...replayParams,
          tokenId: token.id,
        });
      }

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
    creationCommitted = true;

    const assetProfile = mapToAssetProfile(profileRow);

    await auditService.completeCritical(c, auditIntent, {
      action: "create",
      resourceType: "token",
      resourceId: token.id,
      metadata: {
        name: token.name,
        symbol: token.symbol,
        template: resolved.template,
      },
    });
    await completeProfileCreationAudit(c, auditService, {
      organizationId: orgId,
      userId: auth.userId ?? undefined,
      apiKeyId: auth.apiKeyId ?? undefined,
      profileId: assetProfile.id,
      tokenId: token.id,
      assetCategory,
      assetType,
    });

    return created(c, { token: toPublicToken(token), assetProfile });
  } catch (error) {
    if (auditIntent && !creationCommitted) {
      // This attempt did not produce the effect: resolve the admitted intent
      // so the ledger carries an outcome, not an unresolved intent.
      const superseded = await completeFailedIssuanceCreate({
        c,
        auditService,
        auditIntent,
        error,
      });
      if (superseded && idempotencyKey) {
        // A concurrent identical request won the key and rolled us back; its
        // committed record replays (or 409s on a different payload).
        const replayTokenId = await resolveIssuanceCreateReplay(db, replayParams);
        if (replayTokenId) {
          return created(
            c,
            await requireReplayPair(c, replayTokenId, {
              auditService,
              assetCategory,
              assetType,
            })
          );
        }
      }
    }
    throw error;
  }
};

interface ReplayAuditContext {
  auditService: AuditService;
  assetCategory: z.infer<typeof assetCategorySchema>;
  assetType: z.infer<typeof assetTypeSchema>;
}

/**
 * Write the asset-profile creation audit event for a committed pair unless
 * the ledger already carries it. The event follows the committed
 * transaction, so an audit-ledger outage at that moment returns 500 for a
 * creation that did commit — and because the committed idempotency record
 * makes every retry a replay, this repair on the replay path is the only
 * remaining chance to write the missing event.
 */
async function completeProfileCreationAudit(
  c: ValidatedBodyContext<typeof createTokenWithAssetProfileSchema>,
  auditService: AuditService,
  entry: {
    organizationId: string;
    userId?: string;
    apiKeyId?: string;
    profileId: string;
    tokenId: string;
    assetCategory: z.infer<typeof assetCategorySchema>;
    assetType: z.infer<typeof assetTypeSchema>;
  }
) {
  const alreadyWritten = await auditService.hasEvent({
    organizationId: entry.organizationId,
    action: "create",
    resourceType: "asset_profile",
    resourceId: entry.profileId,
  });
  if (alreadyWritten) {
    return;
  }
  await auditService.log(c, {
    organizationId: entry.organizationId,
    userId: entry.userId,
    apiKeyId: entry.apiKeyId,
    action: "create",
    resourceType: "asset_profile",
    resourceId: entry.profileId,
    metadata: {
      tokenId: entry.tokenId,
      assetCategory: entry.assetCategory,
      assetType: entry.assetType,
    },
  });
}

/**
 * Rebuild a replayed creation response from the committed rows under the
 * caller's tenant scope, and re-attempt the profile audit event a prior
 * attempt may have lost after committing. The idempotency record is
 * cascade-deleted with its token, and the profile row is only ever created
 * alongside it, so a missing row here is a broken record. The profile is
 * read regardless of its current status: a replay must return the recorded
 * pair even after it was archived (GET /by-token keeps surfacing only
 * active profiles).
 */
async function requireReplayPair(
  c: ValidatedBodyContext<typeof createTokenWithAssetProfileSchema>,
  tokenId: string,
  creation: ReplayAuditContext
) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const token = await new TokenService(getDb(c.env), getRequestTenantScope(c)).getToken({
    tokenId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!token) {
    throw notFound("Token");
  }
  const profileRow = await createPostgresAssetProfilesRepository(
    getDb(c.env)
  ).getAssetProfileByTokenId({
    tokenId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!profileRow) {
    throw notFound("Asset profile");
  }
  const assetProfile = mapToAssetProfile(profileRow);
  await completeProfileCreationAudit(c, creation.auditService, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    profileId: assetProfile.id,
    tokenId: token.id,
    assetCategory: creation.assetCategory,
    assetType: creation.assetType,
  });
  return { token: toPublicToken(token), assetProfile };
}
