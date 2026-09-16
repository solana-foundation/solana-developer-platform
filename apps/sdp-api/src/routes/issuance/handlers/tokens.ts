import { normalizeTemplateId, resolveTemplateConfig } from "@sdp/issuance/templates";
import { assertValidAddress } from "@sdp/solana/address";
import type { Token } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { asTransactionalClient, getDb } from "@/db";
import { createPostgresAssetProfilesRepository } from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { badRequest, badRequestQuery, conflict, internalError, notFound } from "@/lib/errors";
import { buildDefaultAssetProfile } from "@/lib/issuance/default-asset-profile";
import { created, paginated, success } from "@/lib/response";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  assertApprovedWalletOperationCustodyWallet,
  beginApprovedWalletOperationEffect,
} from "@/services/policy/approved-operation-replay";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import {
  type createTokenSchema,
  getTokenQuerySchema,
  listTokensQuerySchema,
  type updateTokenSchema,
} from "../schemas";
import {
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  type ResolvedIssuanceWallet,
  resolveAllowlistAuthority,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
  resolveIssuanceWallet,
  resolveMetadataAuthority,
} from "./authority-resolution";
import { assertJudgedCustodyWallet, buildIssuancePolicyCandidate } from "./policy";
import { toPublicToken } from "./public-response";

type AppContext = Context<{ Bindings: Env }>;
type TokenRecord = NonNullable<Awaited<ReturnType<TokenService["getToken"]>>>;

function getOnChainMetadataPatch(input: {
  name?: string;
  description?: string | null;
  uri?: string | null;
  imageUrl?: string | null;
}) {
  const patch: {
    name?: string;
    description?: string | null;
    uri?: string | null;
    imageUrl?: string | null;
  } = {};

  if (input.name !== undefined) {
    patch.name = input.name;
  }
  if (input.description !== undefined) {
    patch.description = input.description;
  }
  if (input.uri !== undefined) {
    patch.uri = input.uri;
  }
  if (input.imageUrl !== undefined) {
    patch.imageUrl = input.imageUrl;
  }

  return patch;
}

async function resolveMetadataUpdate(params: {
  c: AppContext;
  auth: ApiKeyContext;
  tokenService: TokenService;
  token: TokenRecord;
  patch: ReturnType<typeof getOnChainMetadataPatch>;
  signingCustodyWalletId?: string;
}) {
  if (
    !params.token.mintAddress ||
    params.token.status === "pending" ||
    Object.keys(params.patch).length === 0
  ) {
    return null;
  }

  const currentAuthority = await resolveCurrentAuthorityForRole(
    params.c.env,
    params.tokenService,
    params.token,
    "metadata"
  );
  if (!currentAuthority) {
    throw badRequest("Metadata authority is not available for this token");
  }

  const authorityWallet = await resolveAuthorityWallet({
    env: params.c.env,
    auth: params.auth,
    currentAuthority,
    requestedCustodyWalletId: params.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });
  assertJudgedCustodyWallet(params.c, authorityWallet.custodyWalletId);
  await assertApprovedWalletOperationCustodyWallet(params.c, authorityWallet.custodyWalletId);
  await admitIssuanceRuntimeExecution({
    env: params.c.env,
    auth: params.auth,
    custodyWalletId: authorityWallet.custodyWalletId,
    tokenService: params.tokenService,
  });
  const signer = await createResolvedAuthoritySigner({
    env: params.c.env,
    auth: params.auth,
    custodyWalletId: authorityWallet.custodyWalletId,
    currentAuthority,
    requiredWalletPermissions: ["tokens:write"],
  });
  const authority = { ...authorityWallet, signer };
  return { authority, patch: params.patch };
}

export const createToken = async (c: ValidatedBodyContext<typeof createTokenSchema>) => {
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const normalizedTemplate = normalizeTemplateId(body.template);
  const resolved = resolveTemplateConfig(
    normalizedTemplate,
    body.overrides,
    body.requiresAllowlist,
    body.decimals
  );

  if (resolved.errors.length > 0) {
    throw badRequest("Invalid template overrides", {
      errors: resolved.errors,
    });
  }

  const signingWallet = body.signingCustodyWalletId
    ? await resolveIssuanceWallet({
        env: c.env,
        auth,
        custodyWalletId: body.signingCustodyWalletId,
        requiredWalletPermissions: ["tokens:write"],
      })
    : null;

  const db = getDb(c.env);
  const token = await db.transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const tokenService = getTenantTokenService(c, client);
    const assetProfiles = createPostgresAssetProfilesRepository(client);

    const token = await tokenService.createToken({
      projectId,
      organizationId: orgId,
      createdBy: auth.id,
      signingCustodyWalletId: signingWallet?.custodyWalletId,
      signingWalletId: signingWallet?.providerWalletId,
      name: body.name,
      symbol: body.symbol,
      decimals: resolved.decimals,
      description: body.description,
      uri: body.uri,
      imageUrl: body.imageUrl,
      template: resolved.template,
      extensions: resolved.extensions ?? undefined,
      maxSupply: body.maxSupply,
      isMintable: body.isMintable,
      isFreezable: body.isFreezable,
      requiresAllowlist: resolved.requiresAllowlist,
    });
    const profile = buildDefaultAssetProfile(token);
    const createdProfile = await assetProfiles.createAssetProfile({
      organizationId: orgId,
      projectId,
      tokenId: token.id,
      ...profile,
      createdBy: auth.id,
    });
    if (!createdProfile) {
      throw internalError("Failed to create the token asset profile");
    }

    return token;
  });

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

  return created(c, { token: toPublicToken(token) });
};

export const listTokens = async (c: AppContext) => {
  const { projectId } = requireProjectScope(c);

  const parsed = listTokensQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }
  const {
    page,
    pageSize,
    search,
    status,
    deploymentStatus,
    template,
    createdAfter,
    createdBefore,
    sortBy,
    sortDirection,
  } = parsed.data;

  if (createdAfter && createdBefore && createdAfter > createdBefore) {
    throw badRequestQuery({
      errors: { createdBefore: ["createdBefore must be at or after createdAfter"] },
    });
  }

  const tokenService = getTenantTokenService(c);
  const { tokens, total } = await tokenService.listTokens(projectId, {
    // A blank search passes validation (an empty input isn't an error) but must
    // not become an `ILIKE '%%'` filter.
    search: search || undefined,
    status,
    deploymentStatus,
    template,
    createdAfter,
    createdBefore,
    sortBy,
    sortDirection,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return paginated(c, tokens.map(toPublicToken), { total, page, pageSize });
};

export const listTokenFacets = async (c: AppContext) => {
  const { projectId } = requireProjectScope(c);

  const tokenService = getTenantTokenService(c);
  const facets = await tokenService.listTokenFacets(projectId);

  return success(c, facets);
};

export const getToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);
  const parsed = getTokenQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const authorities: { allowlistAuthority?: string | null; metadataAuthority?: string | null } = {};
  if (parsed.data.includeAllowlistAuthority === "true") {
    authorities.allowlistAuthority = token.ablListAddress
      ? await resolveAllowlistAuthority(c.env, token.ablListAddress)
      : null;
  }
  if (parsed.data.includeMetadataAuthority === "true") {
    authorities.metadataAuthority = await resolveMetadataAuthority(c.env, tokenService, token);
  }
  return success(c, { token: toPublicToken(token), ...authorities });
};

function validateDraftOnlyUpdates(existing: Token, body: z.infer<typeof updateTokenSchema>) {
  // Access-control enforcement is baked into the mint at deploy; the flag only
  // makes sense to change while the token is still an undeployed draft.
  if (
    body.requiresAllowlist !== undefined &&
    (existing.mintAddress || existing.status !== "pending")
  ) {
    throw badRequest("requiresAllowlist cannot be changed after deployment");
  }

  // Symbol and decimals define the mint itself, so they're immutable once the
  // token is deployed on-chain — only editable while it's an undeployed draft.
  if (
    (body.symbol !== undefined || body.decimals !== undefined) &&
    (existing.mintAddress || existing.status !== "pending")
  ) {
    throw badRequest("symbol and decimals cannot be changed after deployment");
  }

  // SPL carries no supply cap, so SDP enforces it at mint time — which it can
  // only do while it holds the mint authority. Once that authority is revoked
  // (lock-supply), the total can never change again and neither can the cap.
  if (
    body.maxSupply !== undefined &&
    existing.mintAddress &&
    (!existing.isMintable || !existing.mintAuthority)
  ) {
    throw badRequest("maxSupply cannot be changed after the supply is locked on-chain");
  }
}

export const updateToken = async (c: ValidatedBodyContext<typeof updateTokenSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const { signingCustodyWalletId, ...body } = c.req.valid("json");

  const tokenService = getTenantTokenService(c);

  const existing = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });
  if (!existing) {
    throw notFound("Token");
  }

  // `deploying` is an internal transient state, so it is not part of the
  // public TokenStatus union even though it can be observed between the claim
  // and final deployment writes. Reject the whole PATCH during that window.
  if (String(existing.status) === "deploying") {
    throw conflict("Token deployment is in progress; retry after it completes");
  }

  if (
    signingCustodyWalletId &&
    Object.keys(body).length === 0 &&
    (existing.mintAddress || existing.status !== "pending")
  ) {
    throw badRequest("Provide token changes when selecting a signing wallet after deployment");
  }

  let draftWallet: ResolvedIssuanceWallet | null = null;
  if (signingCustodyWalletId && !existing.mintAddress && existing.status === "pending") {
    draftWallet = await resolveIssuanceWallet({
      env: c.env,
      auth,
      custodyWalletId: signingCustodyWalletId,
      requiredWalletPermissions: ["tokens:write"],
    });
  }

  validateDraftOnlyUpdates(existing, body);

  const auditService = new AuditService(getDb(c.env));
  let auditIntent: Awaited<ReturnType<AuditService["beginCritical"]>> | undefined;
  let authoritativeEffectCompleted = false;

  try {
    const metadataPatch = getOnChainMetadataPatch(body);
    const metadataUpdate = await resolveMetadataUpdate({
      c,
      auth,
      tokenService,
      token: existing,
      patch: metadataPatch,
      signingCustodyWalletId,
    });

    auditIntent = await auditService.beginCritical(c, {
      action: "update",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        ...body,
        onChainMetadataUpdatePlanned: metadataUpdate !== null,
        custodyWalletId: metadataUpdate?.authority.custodyWalletId ?? null,
      },
    });

    let metadataUpdateSignature: string | null = null;
    let metadataUpdateSlot: string | null = null;

    if (metadataUpdate) {
      const { signer } = metadataUpdate.authority;

      const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
      await beginApprovedWalletOperationEffect(c);
      const result = await mosaic.updateMetadata({
        mint: assertValidAddress(existing.mintAddress as string, "mintAddress"),
        ...metadataUpdate.patch,
        updateAuthority: signer,
        feePayer: signer,
      });
      authoritativeEffectCompleted = true;

      metadataUpdateSignature = result?.signature ?? null;
      metadataUpdateSlot = result ? result.slot.toString() : null;
    }

    const tokenUpdate = draftWallet
      ? {
          ...body,
          signingCustodyWalletId: draftWallet.custodyWalletId,
          signingWalletId: draftWallet.providerWalletId,
        }
      : body;
    const token = await tokenService.updateToken(tokenId, tokenUpdate, {
      status: existing.status,
      mintAddress: existing.mintAddress,
    });
    authoritativeEffectCompleted = true;

    await auditService.completeCritical(c, auditIntent, {
      metadata: {
        onChainMetadataUpdated: metadataUpdate !== null,
        metadataUpdateSignature,
        metadataUpdateSlot,
      },
    });

    return success(c, { token: toPublicToken(token) });
  } catch (error) {
    if (auditIntent && !authoritativeEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
    }
    if (error instanceof Error && error.message === "TOKEN_NOT_FOUND") {
      throw notFound("Token");
    }
    throw error;
  }
};

export async function extractTokenUpdatePolicyCandidate(
  c: ValidatedBodyContext<typeof updateTokenSchema>
): Promise<PolicyGateExtraction> {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const { signingCustodyWalletId, ...body } = c.req.valid("json");
  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({ tokenId, organizationId: orgId, projectId });
  if (!token) {
    throw notFound("Token");
  }

  // Mirror the handler's deploying-window refusal so a patch that can never
  // sign is not judged (or queued for approval) first.
  if (String(token.status) === "deploying") {
    throw conflict("Token deployment is in progress; retry after it completes");
  }

  const patch = getOnChainMetadataPatch(body);
  const emptyExtraction = {
    legs: [],
    body: c.req.valid("json") as Record<string, unknown>,
    resolved: {},
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "update_metadata",
      // The changed values, not just the keys: an approver deciding on a
      // metadata rewrite needs to see what it changes to.
      patch,
    },
    idempotencyKey: null,
  };

  // A draft-only PATCH mutates database rows and signs nothing: no custody
  // wallet, no wallet operation to judge. The same predicate the handler's
  // resolveMetadataUpdate uses decides whether an on-chain update will sign.
  if (!token.mintAddress || token.status === "pending" || Object.keys(patch).length === 0) {
    return { ...emptyExtraction, candidate: null };
  }

  const currentAuthority = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    "metadata"
  );
  if (!currentAuthority) {
    throw badRequest("Metadata authority is not available for this token");
  }

  const wallet = await resolveAuthorityWallet({
    env: c.env,
    auth,
    currentAuthority,
    requestedCustodyWalletId: signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });

  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId: wallet.custodyWalletId,
    tokenService,
  });

  return {
    ...emptyExtraction,
    resolved: { judgedCustodyWalletId: wallet.custodyWalletId },
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId: wallet.custodyWalletId,
      walletId: wallet.providerWalletId,
      operationType: "issuance_metadata_update_execute",
      amount: null,
      destination: null,
    }),
  };
}
