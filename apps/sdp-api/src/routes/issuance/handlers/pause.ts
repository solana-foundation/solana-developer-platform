import { assertValidAddress } from "@sdp/solana/address";
import { MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@solana/mosaic-sdk";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner } from "@/services/solana";
import type { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { pauseTokenSchema } from "../schemas";
import { buildIdempotencyMetadata } from "./idempotency";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

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
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = pauseTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
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

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const pauseAuthorityRaw = resolvePauseAuthority(token);
  if (!pauseAuthorityRaw) {
    throw badRequest("Pause authority is not configured for this token");
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

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const transaction = await recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: "pause",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenStatus(tx.id, tokenId, "paused");
    }
    return success(c, { transaction });
  }

  if (token.status !== "active") {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: "Token must be active to pause",
    });
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to pause");
  }

  const auditIntent = await auditService.beginCritical(c, {
    action: "pause",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: { tokenId, mode: "execute" },
  });
  let onChainEffectCompleted = false;

  try {
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    if (pauseAuthorityRaw !== signer.address) {
      throw badRequest("Pause authority is not controlled by custody");
    }

    const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

    const result = await mosaic.pauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    onChainEffectCompleted = true;

    const confirmedTx = await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence: {
        signature: result.signature,
        slot: Number(result.slot),
      },
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: result.signature,
            slot: result.slot.toString(),
          },
        }),
    });
    await tokenService.applySettledTokenStatus(tx.id, tokenId, "paused");

    return success(c, { transaction: confirmedTx });
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
      if (error instanceof Error && error.message === MINT_ALREADY_PAUSED_ERROR) {
        await tokenService.updateTransaction(tx.id, {
          status: "failed",
          error: error.message,
        });
        throw badRequest("Token is already paused");
      }
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    throw error;
  }
};

export const unpauseToken = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = pauseTokenSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
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

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const pauseAuthorityRaw = resolvePauseAuthority(token);
  if (!pauseAuthorityRaw) {
    throw badRequest("Pause authority is not configured for this token");
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

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const transaction = await recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: "unpause",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenStatus(tx.id, tokenId, "active");
    }
    return success(c, { transaction });
  }

  if (token.status !== "paused") {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: "Token is not paused",
    });
    throw badRequest("Token is not paused");
  }

  const auditIntent = await auditService.beginCritical(c, {
    action: "unpause",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: { tokenId, mode: "execute" },
  });
  let onChainEffectCompleted = false;

  try {
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    if (pauseAuthorityRaw !== signer.address) {
      throw badRequest("Pause authority is not controlled by custody");
    }

    const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

    const result = await mosaic.unpauseToken({
      mint: mintAddress,
      pauseAuthority: signer,
      feePayer: signer,
    });
    onChainEffectCompleted = true;

    const confirmedTx = await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence: {
        signature: result.signature,
        slot: Number(result.slot),
      },
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: result.signature,
            slot: result.slot.toString(),
          },
        }),
    });
    await tokenService.applySettledTokenStatus(tx.id, tokenId, "active");

    return success(c, { transaction: confirmedTx });
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
      if (error instanceof Error && error.message === MINT_NOT_PAUSED_ERROR) {
        await tokenService.updateTransaction(tx.id, {
          status: "failed",
          error: error.message,
        });
        throw badRequest("Token is not paused");
      }
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    throw error;
  }
};
