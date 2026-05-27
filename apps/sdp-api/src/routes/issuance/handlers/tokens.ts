import type { TokenResponse } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, paginated, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { normalizeTemplateId, resolveTemplateConfig } from "@/services/issuance/templates";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { createTokenSchema, updateTokenSchema } from "../schemas";
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

export const createToken = async (c: AppContext) => {
  const { auth, projectId, orgId } = await requireProjectScope(c);

  const body = await c.req.json();
  const parsed = createTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const normalizedTemplate = normalizeTemplateId(parsed.data.template);
  const resolved = resolveTemplateConfig(
    normalizedTemplate,
    parsed.data.overrides,
    parsed.data.requiresAllowlist,
    parsed.data.decimals
  );

  if (resolved.errors.length > 0) {
    throw new AppError("BAD_REQUEST", "Invalid template overrides", {
      errors: resolved.errors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const signingWalletId = resolveApiKeySigningWalletId(auth, parsed.data.signingWalletId, [
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
    name: parsed.data.name,
    symbol: parsed.data.symbol,
    decimals: resolved.decimals,
    description: parsed.data.description,
    uri: parsed.data.uri,
    imageUrl: parsed.data.imageUrl,
    template: resolved.template,
    extensions: resolved.extensions ?? undefined,
    maxSupply: parsed.data.maxSupply,
    isMintable: parsed.data.isMintable,
    isFreezable: parsed.data.isFreezable,
    requiresAllowlist: resolved.requiresAllowlist,
  });

  // Audit log
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
  const { projectId } = await requireProjectScope(c);

  const status = c.req.query("status") as "pending" | "active" | "paused" | "revoked" | undefined;
  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const tokenService = new TokenService(getDb(c.env));
  const { tokens, total } = await tokenService.listTokens(projectId, {
    status,
    limit: pageSize,
    offset,
  });

  return paginated(c, tokens, { total, page, pageSize });
};

export const getToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  // If using project-scoped key, verify token belongs to that project
  if (token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const response: TokenResponse = { token };
  return success(c, response);
};

export const updateToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));

  // Verify ownership
  const existing = await tokenService.getToken(tokenId);
  if (!existing || existing.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (existing.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  try {
    const metadataPatch = getOnChainMetadataPatch(parsed.data);
    const shouldUpdateMetadataOnChain =
      Boolean(existing.mintAddress) &&
      existing.status !== "pending" &&
      Object.keys(metadataPatch).length > 0;

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
        throw new AppError("BAD_REQUEST", "Metadata authority is not available for this token");
      }

      const { signer } = await resolveAuthoritySigner({
        env: c.env,
        auth,
        token: existing,
        currentAuthority: currentAuthorityRaw,
      });

      const mosaic = createMosaicService(c.env, signer);
      const result = await mosaic.updateMetadata({
        mint: assertValidAddress(existing.mintAddress as string, "mintAddress"),
        ...metadataPatch,
        updateAuthority: signer,
        feePayer: signer,
      });

      metadataUpdateSignature = result?.signature ?? null;
      metadataUpdateSlot = result ? result.slot.toString() : null;
    }

    const token = await tokenService.updateToken(tokenId, parsed.data);

    // Audit log
    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "update",
      resourceType: "token",
      resourceId: tokenId,
      metadata: {
        ...parsed.data,
        onChainMetadataUpdated: shouldUpdateMetadataOnChain,
        metadataUpdateSignature,
        metadataUpdateSlot,
      },
    });

    const response: TokenResponse = { token };
    return success(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "TOKEN_NOT_FOUND") {
      throw notFound("Token");
    }
    throw error;
  }
};
