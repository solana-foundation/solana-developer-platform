import type { MosaicService } from "@sdp/issuance/mosaic/service";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { AuthorityType } from "@solana-program/token-2022";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
  walletOperationExecutionRequest,
} from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { updateAuthoritySchema } from "../schemas";
import {
  type AuthorityRole,
  createResolvedAuthoritySigner,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { enforceIssuanceWalletOperationPolicy } from "./policy";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicAuthorityRole = Parameters<MosaicService["prepareUpdateAuthority"]>[0]["role"];

const mapAuthorityRole = (role: AuthorityRole): MosaicAuthorityRole => {
  switch (role) {
    case "mint":
      return AuthorityType.MintTokens as MosaicAuthorityRole;
    case "freeze":
      return AuthorityType.FreezeAccount as MosaicAuthorityRole;
    case "permanentDelegate":
      return AuthorityType.PermanentDelegate as MosaicAuthorityRole;
    case "metadata":
      return "Metadata" as MosaicAuthorityRole;
  }
};

export const prepareUpdateAuthority = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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

  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = parsed.data.authority.role;
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    role,
    parsed.data.authority.currentAuthority
  );

  if (!currentAuthorityRaw) {
    throw badRequest("Current authority is not available for this token");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const currentAuthority = assertValidAddress(currentAuthorityRaw, "currentAuthority");
  const newAuthority = parsed.data.authority.newAuthority
    ? assertValidAddress(parsed.data.authority.newAuthority, "newAuthority")
    : null;

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: currentAuthorityRaw,
  });
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

  const prepared = await mosaic.prepareUpdateAuthority({
    mint: mintAddress,
    role: mapAuthorityRole(role),
    currentAuthority,
    newAuthority,
    feePayer: signer.address,
  });

  let simulation: unknown;
  if (parsed.data.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "update_authority",
    params: {
      role,
      currentAuthority,
      newAuthority,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update_authority",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      role,
      currentAuthority,
      newAuthority,
      mode: "prepare",
    },
  });

  return success(c, {
    transaction: tx,
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    simulation,
  });
};

export const executeUpdateAuthority = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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

  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = parsed.data.authority.role;
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    role,
    parsed.data.authority.currentAuthority
  );

  if (!currentAuthorityRaw) {
    throw badRequest("Current authority is not available for this token");
  }

  const { walletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: currentAuthorityRaw,
  });

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const newAuthority = parsed.data.authority.newAuthority
    ? assertValidAddress(parsed.data.authority.newAuthority, "newAuthority")
    : null;

  await enforceIssuanceWalletOperationPolicy(c, {
    auth,
    token,
    walletId,
    operationType: "issuance_update_authority_execute",
    destination: newAuthority,
    rawPayload: {
      action: "update_authority",
      role,
      currentAuthority: currentAuthorityRaw,
      newAuthority,
      executionRequest: walletOperationExecutionRequest(c, parsed.data),
    },
  });

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "update_authority",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await runApprovedWalletOperationEffectTransaction(c, (db) =>
    getTenantTokenService(c, db).createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      type: "update_authority",
      params: {
        role,
        currentAuthority: currentAuthorityRaw,
        newAuthority,
      },
      idempotencyKey: idempotencyMetadata.idempotencyKey,
      idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
      initiatedByKeyId: auth.id,
    })
  );

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const transaction = await recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: "update_authority",
    });
    if (
      approvedWalletOperationId(c) &&
      (!transaction.signature ||
        (transaction.status !== "confirmed" && transaction.status !== "finalized"))
    ) {
      // Settlement recovery above may repair a pending row from durable audit
      // evidence. If it cannot, fail closed rather than presenting an
      // unsubmitted authority update as a completed approval.
      await beginApprovedWalletOperationEffect(c);
      throw new AppError(
        "CONFLICT",
        "Approved authority update is incomplete and requires manual reconciliation"
      );
    }
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenAuthority(tx.id, tokenId, role, newAuthority);
    }
    return success(c, { transaction });
  }

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    walletId,
    currentAuthority: currentAuthorityRaw,
  });
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "update_authority",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: { tokenId, role, newAuthority, mode: "execute" },
  });
  let onChainEffectCompleted = false;

  try {
    await beginApprovedWalletOperationEffect(c);
    const result = await mosaic.updateAuthority({
      mint: mintAddress,
      role: mapAuthorityRole(role),
      currentAuthority: signer,
      newAuthority,
      feePayer: signer,
    });
    onChainEffectCompleted = true;

    const updatedTx = await persistSettledTransactionThenOutcome({
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

    await tokenService.applySettledTokenAuthority(tx.id, tokenId, role, newAuthority);

    return success(c, { transaction: updatedTx });
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    throw error;
  }
};
