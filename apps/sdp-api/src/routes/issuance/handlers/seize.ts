import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { seizeSchema } from "../schemas";
import { assertDestinationAllowedByControlList } from "./access-control";
import { resolveAuthoritySigner, resolvePermanentDelegateAuthority } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";

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

  const tokenService = new TokenService(getDb(c.env));
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

  const mosaic = createMosaicService(c.env, signer, "sponsored");
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

  const tokenService = new TokenService(getDb(c.env));
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

  if (replayed) {
    return success(c, { transaction: tx });
  }

  const mosaic = createMosaicService(c.env, signer, "sponsored");

  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
      amount: mosaicAmount,
      permanentDelegate: signer,
      feePayer: signer,
    });

    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
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
        signature: result.signature,
        slot: result.slot.toString(),
        mode: "execute",
      },
    });

    return success(c, { transaction: updatedTx });
  } catch (error) {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
