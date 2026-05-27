import { MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@solana/mosaic-sdk";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { pauseTokenSchema } from "../schemas";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;
type TokenRecord = Awaited<ReturnType<TokenService["getToken"]>>;

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

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (token.projectId !== auth.projectId) {
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

  const signingWalletId = resolveApiKeySigningWalletId(auth, token.signingWalletId, [
    "tokens:admin",
  ]);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "pause",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "pause",
    params: {
      signature: null,
      slot: null,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  if (replayed) {
    return success(c, { transaction: tx });
  }

  try {
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    if (pauseAuthorityRaw !== signer.address) {
      throw new AppError("BAD_REQUEST", "Pause authority is not controlled by custody");
    }

    const mosaic = createMosaicService(c.env, signer);

    const result = await mosaic.pauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });

    await tokenService.updateToken(tokenId, { status: "paused" });
    const confirmedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    const auditService = new AuditService(getDb(c.env));
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

    return success(c, { transaction: confirmedTx });
  } catch (error) {
    if (error instanceof Error && error.message === MINT_ALREADY_PAUSED_ERROR) {
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error.message,
      });
      throw new AppError("BAD_REQUEST", "Token is already paused");
    }
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
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

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (token.projectId !== auth.projectId) {
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

  const signingWalletId = resolveApiKeySigningWalletId(auth, token.signingWalletId, [
    "tokens:admin",
  ]);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "unpause",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "unpause",
    params: {
      signature: null,
      slot: null,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  if (replayed) {
    return success(c, { transaction: tx });
  }

  try {
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    if (pauseAuthorityRaw !== signer.address) {
      throw new AppError("BAD_REQUEST", "Pause authority is not controlled by custody");
    }

    const mosaic = createMosaicService(c.env, signer);

    const result = await mosaic.unpauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });

    await tokenService.updateToken(tokenId, { status: "active" });
    const confirmedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    const auditService = new AuditService(getDb(c.env));
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

    return success(c, { transaction: confirmedTx });
  } catch (error) {
    if (error instanceof Error && error.message === MINT_NOT_PAUSED_ERROR) {
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error.message,
      });
      throw new AppError("BAD_REQUEST", "Token is not paused");
    }
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
