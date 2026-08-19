import { normalizeTemplateId, resolveTemplateConfig } from "@sdp/issuance/templates";
import { assertValidAddress } from "@sdp/solana/address";
import type { TokenResponse } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { badRequest, badRequestQuery, conflict, notFound } from "@/lib/errors";
import { created, paginated, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner } from "@/services/solana";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { type createTokenSchema, listTokensQuerySchema, type updateTokenSchema } from "../schemas";
import { resolveAuthoritySigner, resolveCurrentAuthorityForRole } from "./authority-resolution";

type AppContext = Context<{ Bindings: Env }>;

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

  const tokenService = getTenantTokenService(c);
  const signingWalletId = resolveApiKeySigningWalletId(auth, body.signingWalletId, [
    "tokens:write",
  ]);

  if (signingWalletId) {
    await createOrgSigner(c.env, orgId, projectId, signingWalletId);
  }

  const token = await tokenService.createToken({
    projectId,
    organizationId: orgId,
    createdBy: auth.id,
    signingWalletId,
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

  const auditService = new AuditService(getDb(c.env));
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

  const response: TokenResponse = { token };
  return created(c, response);
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

  return paginated(c, tokens, { total, page, pageSize });
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

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const response: TokenResponse = { token };
  return success(c, response);
};

export const updateToken = async (c: ValidatedBodyContext<typeof updateTokenSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

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

  const auditService = new AuditService(getDb(c.env));
  let auditIntent: Awaited<ReturnType<AuditService["beginCritical"]>> | undefined;
  let authoritativeEffectCompleted = false;

  try {
    const metadataPatch = getOnChainMetadataPatch(body);
    const shouldUpdateMetadataOnChain =
      Boolean(existing.mintAddress) &&
      existing.status !== "pending" &&
      Object.keys(metadataPatch).length > 0;

    auditIntent = await auditService.beginCritical(c, {
      action: "update",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        ...body,
        onChainMetadataUpdatePlanned: shouldUpdateMetadataOnChain,
      },
    });

    let metadataUpdateSignature: string | null = null;
    let metadataUpdateSlot: string | null = null;

    if (shouldUpdateMetadataOnChain) {
      const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
        c.env,
        tokenService,
        existing,
        "metadata"
      );

      if (!currentAuthorityRaw) {
        throw badRequest("Metadata authority is not available for this token");
      }

      const { signer } = await resolveAuthoritySigner({
        env: c.env,
        auth,
        token: existing,
        currentAuthority: currentAuthorityRaw,
      });

      const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
      const result = await mosaic.updateMetadata({
        mint: assertValidAddress(existing.mintAddress as string, "mintAddress"),
        ...metadataPatch,
        updateAuthority: signer,
        feePayer: signer,
      });
      authoritativeEffectCompleted = true;

      metadataUpdateSignature = result?.signature ?? null;
      metadataUpdateSlot = result ? result.slot.toString() : null;
    }

    const token = await tokenService.updateToken(tokenId, body, {
      status: existing.status,
      mintAddress: existing.mintAddress,
    });
    authoritativeEffectCompleted = true;

    await auditService.completeCritical(c, auditIntent, {
      metadata: {
        onChainMetadataUpdated: shouldUpdateMetadataOnChain,
        metadataUpdateSignature,
        metadataUpdateSlot,
      },
    });

    const response: TokenResponse = { token };
    return success(c, response);
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
