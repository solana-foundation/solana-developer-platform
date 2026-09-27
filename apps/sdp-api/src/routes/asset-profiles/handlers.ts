import {
  ASSET_CATEGORIES,
  ASSET_TYPES,
  type AssetCategory,
  type AssetProfile,
  type AssetProfileFieldOptionsResponse,
  type AssetProfileResponse,
  type AssetProfileUpdateResponse,
  getAssetTypeRegistryEntry,
  hasPermission,
  type IssuanceMetadata,
  isAssetTypeSupported,
  type ListAssetProfilesResponse,
  type Token,
} from "@sdp/types";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import type { AssetProfileRow } from "@/db/repositories/asset-profile.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  AppError,
  badRequest,
  badRequestParams,
  badRequestQuery,
  conflict,
  internalError,
  notFound,
} from "@/lib/errors";
import {
  resolveAdvancedSettings,
  selectedAuthorityValuedSettings,
  stampAdvancedSettingsVersion,
  validateAdvancedSettings,
} from "@/lib/issuance/advanced-settings";
import {
  PREPARED_DEPLOY_FENCE_MS,
  profileUsesAdvancedSettings,
  resolvedSnapshotEqualsTokenSnapshot,
  resolveProfileDeploymentSnapshot,
} from "@/lib/issuance/profile-deployment-snapshot";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { noContent, success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { TokenService } from "@/services/token.service";
import { resolveIssuanceWallet } from "../issuance/handlers/authority-resolution";
import { toPublicToken } from "../issuance/handlers/public-response";
import { getTenantTokenService } from "../issuance/helpers";
import { type AppContext, getAssetProfilesRepository } from "./context";
import {
  assetProfileIdParamsSchema,
  assetProfileTokenIdParamsSchema,
  listAssetProfilesQuerySchema,
  type updateAssetProfileSchema,
} from "./schemas";

export function mapToAssetProfile(row: AssetProfileRow): AssetProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    tokenId: row.token_id,
    assetCategory: row.asset_category,
    assetType: row.asset_type,
    assetTypeVersion: row.asset_type_version,
    issuanceMetadata: row.issuance_metadata,
    publicMetadata: row.public_metadata,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MetadataRecord)
    : null;
}

// Collapse the two capacity encodings — legacy `{ key: true }` and current
// `{ key: { enabled, config } }` — so a re-serialized-but-unchanged policy does
// not read as a change. Disabled entries drop out entirely.
function normalizeCapacities(value: unknown): MetadataRecord | null {
  const source = asRecord(value);
  if (!source) {
    return null;
  }
  const normalized: MetadataRecord = {};
  for (const [key, raw] of Object.entries(source)) {
    if (raw === true) {
      normalized[key] = { enabled: true };
      continue;
    }
    const entry = asRecord(raw);
    if (!entry || entry.enabled === false) {
      continue;
    }
    normalized[key] =
      entry.config !== undefined ? { enabled: true, config: entry.config } : { enabled: true };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

// A stable, order-independent view of just the admin-governed compliance policy:
// advanced settings selection, the off-chain capacities, and the access-control
// mode. Everything else on the profile (asset details, public-info visibility)
// stays at tokens:write.
function compliancePolicyView(
  metadata: unknown,
  options: {
    assetCategory?: AssetCategory;
    assetType?: string;
    // Effective access control when the metadata does not carry one: the
    // dashboard derives the mode from the token's columns (requiresAllowlist /
    // template) and writes it back on save, so a stored profile without
    // compliance.accessControl must not treat that round-trip as a change.
    accessControlFallback?: string | null;
    // Category/type feed the settings resolver (template + freeze derivation),
    // so a category/type-only PATCH is policy when settings are asserted.
    governCategoryType?: boolean;
  } = {}
): unknown {
  const source = asRecord(metadata) ?? {};
  const settings = asRecord(source.settings);
  const compliance = asRecord(source.compliance);
  return {
    ...(options.governCategoryType
      ? { assetCategory: options.assetCategory ?? null, assetType: options.assetType ?? null }
      : {}),
    // `settings.version` is server-stamped, not policy — compare the selection.
    settings: settings?.selected ?? null,
    accessControl: compliance?.accessControl ?? options.accessControlFallback ?? null,
    capacities: normalizeCapacities(compliance?.capacities),
  };
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortRecursively(record[key])])
  );
}

// One side of a policy comparison: the metadata plus the category/type whose
// registry entry shapes what its settings resolve to.
export interface CompliancePolicySide {
  metadata: unknown;
  assetCategory?: AssetCategory;
  assetType?: string;
  accessControlFallback?: string | null;
}

function compliancePolicyChangedSides(before: CompliancePolicySide, after: CompliancePolicySide) {
  const governCategoryType =
    profileUsesAdvancedSettings((before.metadata ?? {}) as IssuanceMetadata) ||
    profileUsesAdvancedSettings((after.metadata ?? {}) as IssuanceMetadata);
  return (
    JSON.stringify(
      sortRecursively(
        compliancePolicyView(before.metadata, {
          assetCategory: before.assetCategory,
          assetType: before.assetType,
          accessControlFallback: before.accessControlFallback,
          governCategoryType,
        })
      )
    ) !==
    JSON.stringify(
      sortRecursively(
        compliancePolicyView(after.metadata, {
          assetCategory: after.assetCategory,
          assetType: after.assetType,
          accessControlFallback: after.accessControlFallback,
          governCategoryType,
        })
      )
    )
  );
}

// True when a PATCH would alter the compliance policy vs. the persisted profile.
// Editing the policy requires tokens:admin even though the route gate is
// tokens:write; this is the server backstop for the admin-only compliance tab.
export function compliancePolicyChanged(before: unknown, after: unknown): boolean {
  return compliancePolicyChangedSides({ metadata: before }, { metadata: after });
}

// The access-control mode a token's own columns imply — the same derivation the
// dashboard's access-control utils perform when hydrating a profile that never
// stored compliance.accessControl.
function tokenAccessControlFallback(token: Token): string {
  if (token.requiresAllowlist) {
    return "allowlist";
  }
  return token.template === "stablecoin" || token.template === "tokenized-security"
    ? "blocklist"
    : "disabled";
}

export const getAssetProfileFieldOptions = async (c: AppContext) => {
  const response: AssetProfileFieldOptionsResponse = {
    fields: {
      categories: ASSET_CATEGORIES,
      types: ASSET_TYPES,
    },
  };
  return success(c, response);
};

export const listAssetProfiles = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const parsed = listAssetProfilesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const { page, pageSize, includeArchived, category, tokenIds } = parsed.data;

  const repo = getAssetProfilesRepository(c);
  const { rows, total } = await repo.listAssetProfiles({
    organizationId: auth.organizationId,
    projectId,
    category,
    includeArchived,
    tokenIds,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const response: ListAssetProfilesResponse = {
    assetProfiles: rows.map(mapToAssetProfile),
    total,
    page,
    pageSize,
  };

  return success(c, response);
};

export const getAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getAssetProfilesRepository(c);
  const profile = await repo.getAssetProfileById({
    profileId: params.data.profileId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!profile) {
    throw notFound("Asset profile");
  }

  const response: AssetProfileResponse = { assetProfile: mapToAssetProfile(profile) };
  return success(c, response);
};

export const getAssetProfileByTokenId = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileTokenIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const repo = getAssetProfilesRepository(c);
  const profile = await repo.getActiveAssetProfileByTokenId({
    tokenId: params.data.tokenId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!profile) {
    throw notFound("Asset profile");
  }

  const response: AssetProfileResponse = { assetProfile: mapToAssetProfile(profile) };
  return success(c, response);
};

/** The deployment-snapshot fields a pending-token save writes, as resolved. */
interface PendingSnapshotSync {
  template: Token["template"];
  isFreezable: boolean;
  requiresAllowlist: boolean;
  extensions: Token["extensions"];
}

/**
 * Decide what a profile save does to its pending token's deployment snapshot.
 *
 * A token that already deployed (or is mid-claim) has an immutable mint: a
 * compliance-policy change can never reach it, so refuse instead of letting the
 * reviewed profile silently diverge from what was initialized. A pending token
 * re-resolves the saved selection through the creation-time resolver — the same
 * authority validation included — so the reviewed settings and the snapshot
 * commit together.
 *
 * Returns null when there is nothing to sync: the token is not pending, or the
 * profile never asserted advanced settings (legacy template + overrides).
 */
async function resolvePendingSnapshotSync(params: {
  env: Parameters<typeof resolveIssuanceWallet>[0]["env"];
  auth: ReturnType<typeof getAuth>;
  token: Token;
  policyChanged: boolean;
  usesAdvancedSettings: boolean;
  assetCategory: AssetCategory;
  assetType: string;
  metadata: IssuanceMetadata;
}): Promise<PendingSnapshotSync | null> {
  const { token } = params;
  if (token.status !== "pending" || token.mintAddress) {
    if (params.policyChanged) {
      throw conflict(
        "This asset profile's compliance policy can no longer be changed because its token has already been deployed"
      );
    }
    return null;
  }
  if (!params.usesAdvancedSettings) {
    return null;
  }

  // Authority-valued settings resolve to a real wallet exactly like creation:
  // reuse the delegate already stamped on the pending token, else the signing
  // custody wallet it will deploy from, else refuse rather than brick the mint
  // with a missing authority.
  const authoritySettings = selectedAuthorityValuedSettings(params.metadata);
  let permanentDelegateAuthority: string | undefined;
  if (authoritySettings.length > 0) {
    if (typeof token.extensions?.permanentDelegate === "string") {
      permanentDelegateAuthority = token.extensions.permanentDelegate;
    } else if (token.signingCustodyWalletId) {
      const signingWallet = await resolveIssuanceWallet({
        env: params.env,
        auth: params.auth,
        custodyWalletId: token.signingCustodyWalletId,
        requiredWalletPermissions: ["tokens:write"],
      });
      permanentDelegateAuthority = signingWallet.publicKey;
    } else {
      throw badRequest("A signing wallet is required for the selected advanced settings", {
        errors: authoritySettings.map((settingKey) => ({
          settingKey,
          reason: "signing_wallet_required",
        })),
      });
    }
  }

  const resolved = resolveProfileDeploymentSnapshot({
    assetCategory: params.assetCategory,
    assetType: params.assetType,
    issuanceMetadata: params.metadata,
    decimals: token.decimals,
    requiresAllowlist: token.requiresAllowlist,
    permanentDelegateAuthority,
  });
  if (resolved.errors.length > 0) {
    throw badRequest("Invalid advanced settings combination", { errors: resolved.errors });
  }
  return {
    template: resolved.template,
    isFreezable: resolved.isFreezable,
    requiresAllowlist: resolved.requiresAllowlist,
    extensions: resolved.extensions,
  };
}

export const updateAssetProfile = async (
  c: ValidatedBodyContext<typeof updateAssetProfileSchema>
) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const body = c.req.valid("json");

  const { profileId } = params.data;
  const repo = getAssetProfilesRepository(c);

  const current = await repo.getAssetProfileById({
    profileId,
    organizationId: auth.organizationId,
    projectId,
  });
  if (!current) {
    throw notFound("Asset profile");
  }

  // Resolve the effective category/type by merging the patch over the existing
  // row, then validate the pair (the schema can only check it when both are sent).
  const nextCategory = body.assetCategory ?? current.asset_category;
  const nextType = body.assetType ?? current.asset_type;
  if (!isAssetTypeSupported(nextCategory, nextType)) {
    throw badRequest(`Unsupported assetType "${nextType}" for category "${nextCategory}"`);
  }

  const registryEntry = getAssetTypeRegistryEntry(nextCategory, nextType);
  if (!registryEntry) {
    throw internalError("Missing registry entry for a validated asset type");
  }

  const typeChanged = nextCategory !== current.asset_category || nextType !== current.asset_type;
  const metadataChanged = body.issuanceMetadata !== undefined;

  // The token's own access-control columns normalize the policy view: the
  // dashboard writes back a mode it derived from them when the stored profile
  // never carried one, and that round-trip is not a policy change.
  const preGateToken = current.token_id
    ? await getTenantTokenService(c).getToken({
        tokenId: current.token_id,
        organizationId: auth.organizationId,
        projectId,
      })
    : null;
  const accessControlFallback = preGateToken ? tokenAccessControlFallback(preGateToken) : null;

  // Compliance policy is admin-governed. The route gate (tokens:write) covers
  // the rest of the profile, but changing the advanced settings, capacities, or
  // access-control mode requires tokens:admin — mirroring the admin-only
  // compliance tab in the dashboard. A category/type change is policy too when
  // the profile asserts advanced settings: the resolver derives the template
  // and freeze behavior from them (so a tokens:write caller could otherwise
  // rewrite the effective policy through the category selector alone).
  if (
    (body.issuanceMetadata !== undefined || typeChanged) &&
    compliancePolicyChangedSides(
      {
        metadata: current.issuance_metadata,
        assetCategory: current.asset_category,
        assetType: current.asset_type,
        accessControlFallback,
      },
      {
        metadata: body.issuanceMetadata ?? current.issuance_metadata,
        assetCategory: nextCategory,
        assetType: nextType,
        accessControlFallback,
      }
    ) &&
    !hasPermission(auth.permissions, "tokens:admin")
  ) {
    throw new AppError(
      "INSUFFICIENT_PERMISSIONS",
      "Editing compliance policy requires the tokens:admin permission"
    );
  }

  // Validate settings when metadata or type changed; catches unsupported by type change too.
  if (metadataChanged || typeChanged) {
    const effectiveMetadata = body.issuanceMetadata ?? current.issuance_metadata;
    const settingErrors = validateAdvancedSettings(nextCategory, nextType, effectiveMetadata);
    if (settingErrors.length > 0) {
      throw badRequest("Invalid advanced settings", { errors: settingErrors });
    }
    const buildErrors = resolveAdvancedSettings(nextCategory, nextType, effectiveMetadata);
    if (buildErrors.length > 0) {
      throw badRequest("Invalid advanced settings combination", { errors: buildErrors });
    }
  }

  // Stamp version only on metadata we persist.
  const persistedMetadata =
    body.issuanceMetadata !== undefined
      ? stampAdvancedSettingsVersion(body.issuanceMetadata)
      : undefined;
  const nextMetadata = persistedMetadata ?? current.issuance_metadata;

  // Recompute public projection when inputs change.
  const publicMetadata =
    typeChanged || metadataChanged
      ? projectPublicMetadata(nextCategory, nextType, nextMetadata)
      : undefined;

  // APE-848: a pending token deploys from its issued_tokens snapshot (template,
  // freeze-authority flag, allowlist flag, extension rows), while the reviewed
  // profile above is what the dashboard shows. Resolve the saved advanced
  // settings through the creation-time resolver and persist the resulting
  // snapshot atomically with the profile row, so the two can never diverge.
  // Profiles that never asserted settings (legacy template + overrides) and
  // tokens that already deployed (their mint is immutable) keep the previous
  // behavior; a policy change on the latter is refused rather than silently
  // diverging from the mint it cannot reach.
  const db = getDb(c.env);
  const tenantScope = getRequestTenantScope(c);
  const policySide = (metadata: unknown, assetCategory: AssetCategory, assetType: string) => ({
    metadata,
    assetCategory,
    assetType,
    accessControlFallback,
  });
  const policyChanged = compliancePolicyChangedSides(
    policySide(current.issuance_metadata, current.asset_category, current.asset_type),
    policySide(nextMetadata, nextCategory, nextType)
  );
  const usesAdvancedSettings =
    profileUsesAdvancedSettings(nextMetadata) ||
    profileUsesAdvancedSettings(current.issuance_metadata);

  const { updated, syncedToken } = await db.transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const transactionalProfilesRepo = createPostgresAssetProfilesRepository(client);
    const tokenService = new TokenService(client, tenantScope);

    // Inside the transaction so the deployed/pending decision reads the same
    // snapshot the guarded writes below contend with.
    const profileToken = await tokenService.getToken({
      tokenId: current.token_id,
      organizationId: auth.organizationId,
      projectId,
    });

    const snapshot = profileToken
      ? await resolvePendingSnapshotSync({
          env: c.env,
          auth,
          token: profileToken,
          policyChanged,
          usesAdvancedSettings,
          assetCategory: nextCategory,
          assetType: nextType,
          metadata: nextMetadata,
        })
      : null;

    const profileRow = await transactionalProfilesRepo.updateAssetProfile({
      profileId,
      organizationId: auth.organizationId,
      projectId,
      assetCategory: body.assetCategory,
      assetType: body.assetType,
      assetTypeVersion: typeChanged ? registryEntry.version : undefined,
      issuanceMetadata: persistedMetadata,
      publicMetadata,
    });

    if (!profileRow) {
      throw notFound("Asset profile");
    }

    let syncedTokenRow: Token | null = null;
    if (snapshot) {
      // A client-signed deploy prepare hands the caller a transaction minted
      // from the snapshot as it stood at prepare time. If this save would
      // rewrite any snapshot field while that transaction can still land, its
      // mint would carry the old policy while confirm verifies the new one —
      // the recorded-mint mismatch that strands the mint. Refuse the rewrite
      // until the prepare's marker row is closed (or its blockhash expires);
      // a value-identical re-save rewrites nothing and is harmless.
      const snapshotUnchanged =
        profileToken && resolvedSnapshotEqualsTokenSnapshot(snapshot, profileToken);
      if (
        snapshotUnchanged === false &&
        (await tokenService.expireStalePreparedDeploys(current.token_id, PREPARED_DEPLOY_FENCE_MS))
      ) {
        throw conflict(
          "A prepared client-signed deployment is in flight for this token; confirm it, let it expire, or discard it before changing its deployment settings"
        );
      }
      // Guarded on pending + no mint inside the same transaction: losing the
      // guard means a deploy claimed the token mid-save, so neither side of the
      // reviewed agreement may land.
      syncedTokenRow = await tokenService.syncPendingTokenDeploymentSnapshot({
        tokenId: current.token_id,
        template: snapshot.template,
        isFreezable: snapshot.isFreezable,
        requiresAllowlist: snapshot.requiresAllowlist,
        extensions: snapshot.extensions,
      });
      if (!syncedTokenRow) {
        throw conflict(
          "Token deployment state changed while saving the asset profile; re-fetch and retry"
        );
      }
    }

    return { updated: profileRow, syncedToken: syncedTokenRow };
  });

  const auditService = new AuditService(db);
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "update",
    resourceType: "asset_profile",
    resourceId: profileId,
    metadata: {
      changedFields: Object.keys(body),
      ...(syncedToken ? { syncedTokenSnapshot: true } : {}),
    },
  });

  // The updated token snapshot rides along when the save re-resolved it, so
  // callers see exactly what a deploy would now initialize.
  const response: AssetProfileUpdateResponse = {
    assetProfile: mapToAssetProfile(updated),
    ...(syncedToken ? { token: toPublicToken(syncedToken) } : {}),
  };
  return success(c, response);
};

export const archiveAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const params = assetProfileIdParamsSchema.safeParse(c.req.param());

  if (!params.success) {
    throw badRequestParams();
  }

  const { profileId } = params.data;
  const repo = getAssetProfilesRepository(c);

  const archived = await repo.archiveAssetProfile({
    profileId,
    organizationId: auth.organizationId,
    projectId,
  });

  if (!archived) {
    throw notFound("Asset profile");
  }

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    organizationId: auth.organizationId,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined,
    action: "delete",
    resourceType: "asset_profile",
    resourceId: profileId,
  });

  return noContent(c);
};
