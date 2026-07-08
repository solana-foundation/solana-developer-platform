import { getAssetTypeRegistryEntry, type TokenWithAssetProfileResponse } from "@sdp/types";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { resolveCreatorUserId } from "@/lib/creator";
import { badRequest, internalError } from "@/lib/errors";
import { projectPublicMetadata } from "@/lib/issuance/public-metadata";
import { created } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { normalizeTemplateId, resolveTemplateConfig } from "@/services/issuance/templates";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import { createTokenWithAssetProfileSchema } from "../issuance/schemas";
import type { AppContext } from "./context";
import { mapToAssetProfile } from "./handlers";

/**
 * POST /v1/issuance/asset-profiles — create an issued token and its asset
 * profile in a single request.
 *
 * The token row and the profile row are written inside one DB transaction: if
 * either insert fails, both roll back, so we never persist a token without a
 * profile.
 */
export const createTokenWithAssetProfile = async (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const orgId = auth.organizationId;

  const body = await c.req.json();
  const parsed = createTokenWithAssetProfileSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const { assetCategory, assetType, issuanceMetadata, ...tokenInput } = parsed.data;

  const normalizedTemplate = normalizeTemplateId(tokenInput.template);
  const resolved = resolveTemplateConfig(
    normalizedTemplate,
    tokenInput.overrides,
    tokenInput.requiresAllowlist,
    tokenInput.decimals
  );

  if (resolved.errors.length > 0) {
    throw badRequest("Invalid template overrides", {
      errors: resolved.errors,
    });
  }

  // Validate the asset type here (before opening a transaction) so a bad
  // category/type never gets as far as inserting a token.
  const registryEntry = getAssetTypeRegistryEntry(assetCategory, assetType);
  if (!registryEntry) {
    throw internalError("Missing registry entry for a validated asset type");
  }

  const signingWalletId = resolveApiKeySigningWalletId(auth, tokenInput.signingWalletId, [
    "tokens:write",
  ]);

  // Custody signer provisioning is idempotent setup, kept outside the DB
  // transaction (it may reach an external custody provider that cannot roll back).
  if (signingWalletId) {
    await createOrgSigner(c.env, orgId, projectId, signingWalletId);
  }

  const metadata = issuanceMetadata ?? {};
  const publicMetadata = projectPublicMetadata(assetCategory, assetType, metadata);
  const createdBy = await resolveCreatorUserId(c);

  const db = getDb(c.env);

  const { token, profileRow } = await db.transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const tokenService = new TokenService(client);
    const assetProfilesRepo = createPostgresAssetProfilesRepository(client);

    const token = await tokenService.createToken({
      projectId,
      organizationId: orgId,
      createdBy: auth.id,
      signingWalletId,
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
      // Throw to roll back the token insert we just made in this transaction.
      throw internalError("Failed to create asset profile");
    }

    return { token, profileRow };
  });

  const assetProfile = mapToAssetProfile(profileRow);

  // Audit outside the transaction: a failed audit write must not roll back a
  // committed token + profile.
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

  const response: TokenWithAssetProfileResponse = { token, assetProfile };
  return created(c, response);
};
