import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { seizeSchema } from "../schemas";
import { assertDestinationAllowedByControlList } from "./access-control";
import { resolveAuthoritySigner, resolvePermanentDelegateAuthority } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;

export const prepareSeize = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = seizeSchema.safeParse(body);

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

  assertTokenAllowsOperation(token, "seize");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(parsed.data.seize.amount, token.decimals);

  const isOnControlList = await tokenService.isAddressAllowed(
    tokenId,
    parsed.data.seize.destination
  );
  assertDestinationAllowedByControlList({
    token,
    destination: parsed.data.seize.destination,
    isOnControlList,
  });

  const permanentDelegateRaw =
    parsed.data.seize.delegateAuthority ??
    (await resolvePermanentDelegateAuthority(c.env, tokenService, token));
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: permanentDelegateRaw,
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.seize.source, "source");
  const destination = assertValidAddress(parsed.data.seize.destination, "destination");
  const permanentDelegate = assertValidAddress(permanentDelegateRaw, "delegateAuthority");

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const prepared = await mosaic.prepareForceTransfer({
    mint: mintAddress,
    source,
    destination,
    amount: mosaicAmount,
    permanentDelegate,
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
    type: "seize",
    params: {
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: parsed.data.seize.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "seize",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
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

export const executeSeize = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = seizeSchema.safeParse(body);

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

  assertTokenAllowsOperation(token, "seize");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(parsed.data.seize.amount, token.decimals);

  const isOnControlList = await tokenService.isAddressAllowed(
    tokenId,
    parsed.data.seize.destination
  );
  assertDestinationAllowedByControlList({
    token,
    destination: parsed.data.seize.destination,
    isOnControlList,
  });

  const permanentDelegateRaw =
    parsed.data.seize.delegateAuthority ??
    (await resolvePermanentDelegateAuthority(c.env, tokenService, token));
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: permanentDelegateRaw,
  });

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.seize.source, "source");
  const destination = assertValidAddress(parsed.data.seize.destination, "destination");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "seize",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "seize",
    params: {
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: parsed.data.seize.memo,
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
      action: "seize",
    });
    return success(c, { transaction });
  }

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "seize",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: parsed.data.seize.source,
      destination: parsed.data.seize.destination,
      amount: parsed.data.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      mode: "execute",
    },
  });
  let onChainEffectCompleted = false;

  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
      amount: mosaicAmount,
      permanentDelegate: signer,
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

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "seize",
      signature: result.signature,
      slot: result.slot.toString(),
    });

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
