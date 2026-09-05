import { createRpcForSdk } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { inspectToken, MINT_ALREADY_PAUSED_ERROR, MINT_NOT_PAUSED_ERROR } from "@solana/mosaic-sdk";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { pauseTokenSchema } from "../schemas";
import {
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  resolveAuthorityWallet,
  resolveDirectIssuanceReplay,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { toPublicTokenTransaction } from "./public-response";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type MosaicSdkRpc = Parameters<typeof inspectToken>[0];

async function resolvePauseAuthority(env: Env, mintAddress: ReturnType<typeof assertValidAddress>) {
  const token = await inspectToken(createRpcForSdk<MosaicSdkRpc>(env), mintAddress);
  return token.authorities.pausableAuthority ?? null;
}

export const pauseToken = async (c: ValidatedBodyContext<typeof pauseTokenSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const idempotencyForWallet = (custodyWalletId: string) =>
    buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
      tokenId,
      operation: "pause",
      mode: "execute",
      params: { ...body, signingCustodyWalletId: custodyWalletId },
    });
  const earlyReplay = await resolveDirectIssuanceReplay({
    env: c.env,
    auth,
    tokenService,
    tokenId,
    type: "pause",
    idempotencyKey: c.req.header("Idempotency-Key"),
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
    fingerprintForCustodyWalletId: (custodyWalletId) =>
      idempotencyForWallet(custodyWalletId).idempotencyFingerprint,
  });
  if (earlyReplay) {
    const transaction = await recoverSettledTransactionReplay({
      auditService: new AuditService(getDb(c.env)),
      tokenService,
      transaction: earlyReplay,
      action: "pause",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenStatus(transaction.id, tokenId, "paused");
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const pauseAuthorityRaw = await resolvePauseAuthority(c.env, mintAddress);
  if (!pauseAuthorityRaw) {
    throw badRequest("Pause authority is not configured for this token");
  }

  const { custodyWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    currentAuthority: pauseAuthorityRaw,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
  });

  const idempotencyMetadata = idempotencyForWallet(custodyWalletId);

  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId,
    tokenService,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
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
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
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
    metadata: { tokenId, mode: "execute", custodyWalletId },
  });
  let onChainEffectCompleted = false;

  try {
    const signer = await createResolvedAuthoritySigner({
      env: c.env,
      auth,
      custodyWalletId,
      currentAuthority: pauseAuthorityRaw,
      requiredWalletPermissions: ["tokens:admin"],
    });

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

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "pause",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    return success(c, { transaction: toPublicTokenTransaction(confirmedTx) });
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

export const unpauseToken = async (c: ValidatedBodyContext<typeof pauseTokenSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const idempotencyForWallet = (custodyWalletId: string) =>
    buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
      tokenId,
      operation: "unpause",
      mode: "execute",
      params: { ...body, signingCustodyWalletId: custodyWalletId },
    });
  const earlyReplay = await resolveDirectIssuanceReplay({
    env: c.env,
    auth,
    tokenService,
    tokenId,
    type: "unpause",
    idempotencyKey: c.req.header("Idempotency-Key"),
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
    fingerprintForCustodyWalletId: (custodyWalletId) =>
      idempotencyForWallet(custodyWalletId).idempotencyFingerprint,
  });
  if (earlyReplay) {
    const transaction = await recoverSettledTransactionReplay({
      auditService: new AuditService(getDb(c.env)),
      tokenService,
      transaction: earlyReplay,
      action: "unpause",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenStatus(transaction.id, tokenId, "active");
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const pauseAuthorityRaw = await resolvePauseAuthority(c.env, mintAddress);
  if (!pauseAuthorityRaw) {
    throw badRequest("Pause authority is not configured for this token");
  }

  const { custodyWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    currentAuthority: pauseAuthorityRaw,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
  });

  const idempotencyMetadata = idempotencyForWallet(custodyWalletId);

  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId,
    tokenService,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
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
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
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
    metadata: { tokenId, mode: "execute", custodyWalletId },
  });
  let onChainEffectCompleted = false;

  try {
    const signer = await createResolvedAuthoritySigner({
      env: c.env,
      auth,
      custodyWalletId,
      currentAuthority: pauseAuthorityRaw,
      requiredWalletPermissions: ["tokens:admin"],
    });

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

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "unpause",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    return success(c, { transaction: toPublicTokenTransaction(confirmedTx) });
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
