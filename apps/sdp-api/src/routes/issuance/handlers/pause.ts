import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@mosaic/sdk";
import type { Context } from "hono";
import { pauseTokenSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;
type TokenRecord = Awaited<ReturnType<TokenService["prototype"]["getToken"]>>;

const resolvePauseAuthority = (token: TokenRecord): string | null => {
  if (!token) {
    return null;
  }
  return token.extensions?.pausable?.authority ?? token.mintAuthority ?? null;
};

export const pauseToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = pauseTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to pause");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const pauseAuthorityRaw = resolvePauseAuthority(token);
  if (!pauseAuthorityRaw) {
    throw new AppError("BAD_REQUEST", "Pause authority is not configured for this token");
  }

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  if (pauseAuthorityRaw !== signer.address) {
    throw new AppError("BAD_REQUEST", "Pause authority is not controlled by custody");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");

  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.pauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });

    await tokenService.updateToken(tokenId, { status: "paused" });

    const tx = await tokenService.createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      type: "pause",
      params: {
        signature: result.signature,
        slot: result.slot.toString(),
      },
      initiatedByKeyId: auth.id,
    });

    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "pause",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    return success(c, { transaction: tx });
  } catch (error) {
    if (error instanceof Error && error.message === MINT_ALREADY_PAUSED_ERROR) {
      throw new AppError("BAD_REQUEST", "Token is already paused");
    }
    throw error;
  }
};

export const unpauseToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = pauseTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  if (token.status !== "paused") {
    throw new AppError("BAD_REQUEST", "Token is not paused");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const pauseAuthorityRaw = resolvePauseAuthority(token);
  if (!pauseAuthorityRaw) {
    throw new AppError("BAD_REQUEST", "Pause authority is not configured for this token");
  }

  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  if (pauseAuthorityRaw !== signer.address) {
    throw new AppError("BAD_REQUEST", "Pause authority is not controlled by custody");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");

  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.unpauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });

    await tokenService.updateToken(tokenId, { status: "active" });

    const tx = await tokenService.createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      type: "unpause",
      params: {
        signature: result.signature,
        slot: result.slot.toString(),
      },
      initiatedByKeyId: auth.id,
    });

    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "unpause",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    return success(c, { transaction: tx });
  } catch (error) {
    if (error instanceof Error && error.message === MINT_NOT_PAUSED_ERROR) {
      throw new AppError("BAD_REQUEST", "Token is not paused");
    }
    throw error;
  }
};
