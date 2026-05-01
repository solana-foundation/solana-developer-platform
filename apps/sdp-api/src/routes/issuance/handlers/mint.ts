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
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import { mintSchema } from "../schemas";
import { assertDestinationAllowedByControlList } from "./access-control";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;

export const prepareMint = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = mintSchema.safeParse(body);

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

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const { mintAddress: mintAddressRaw, mosaicAmount } = resolveMintOperationAmount(
    token,
    parsed.data.mint.amount
  );

  const isOnControlList = await tokenService.isAddressAllowed(
    tokenId,
    parsed.data.mint.destination
  );
  assertDestinationAllowedByControlList({
    token,
    destination: parsed.data.mint.destination,
    isOnControlList,
  });

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Get mint authority (custody signer via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mintAuthority = assertValidAddress(token.mintAuthority ?? "", "mintAuthority");
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  // Build unsigned transaction using Mosaic
  // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
  const mosaic = createMosaicService(c.env, signer);
  const prepared = await mosaic.prepareMintTo({
    mint: mintAddress,
    destination,
    amount: mosaicAmount,
    mintAuthority,
    feePayer: signer.address,
  });

  let simulation: unknown;
  if (parsed.data.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  // Create transaction record with serialized tx
  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "mint",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
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
    tokenAccount: prepared.tokenAccount,
    simulation,
  });
};

export const executeMint = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = mintSchema.safeParse(body);

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

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const { mintAddress: mintAddressRaw, mosaicAmount } = resolveMintOperationAmount(
    token,
    parsed.data.mint.amount
  );

  const isOnControlList = await tokenService.isAddressAllowed(
    tokenId,
    parsed.data.mint.destination
  );
  assertDestinationAllowedByControlList({
    token,
    destination: parsed.data.mint.destination,
    isOnControlList,
  });

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "mint",
    mode: "execute",
    params: parsed.data,
  });

  // Create transaction record first
  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (replayed) {
    const txTokenAccount =
      typeof tx.params.tokenAccount === "string" ? tx.params.tokenAccount : undefined;
    return success(c, {
      transaction: tx,
      tokenAccount: txTokenAccount ?? parsed.data.mint.destination,
    });
  }

  try {
    // Get custody signer (via 3-tier resolution)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );

    // Execute mint on Solana using Mosaic
    // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
    const mosaic = createMosaicService(c.env, signer);

    const result = await mosaic.mintTo({
      mint: mintAddress,
      destination,
      amount: mosaicAmount,
      mintAuthority: signer.address,
      feePayer: signer.address,
    });

    // Update transaction with confirmation
    // Update token supply
    await tokenService.updateSupply(tokenId, parsed.data.mint.amount, "mint");

    // Audit log
    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "mint",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        destination: parsed.data.mint.destination,
        amount: parsed.data.mint.amount,
        signature: result.signature,
        slot: result.slot.toString(),
        mode: "execute",
      },
    });

    return success(c, {
      transaction: await tokenService.updateTransaction(tx.id, {
        status: "confirmed",
        signature: result.signature,
        slot: Number(result.slot),
        params: {
          ...tx.params,
          tokenAccount: result.tokenAccount,
        },
      }),
      tokenAccount: result.tokenAccount,
    });
  } catch (error) {
    // Update transaction as failed
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
