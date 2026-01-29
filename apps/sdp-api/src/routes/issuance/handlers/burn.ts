import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createSigner, createToken2022Service } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import { burnSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const prepareBurn = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = burnSchema.safeParse(body);

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
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to burn");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  // Validate addresses and get custody authority
  const signer = await createSigner(c.env);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.burn.source, "source");

  // Build unsigned transaction
  const token2022 = createToken2022Service(c.env);
  const prepared = await token2022.prepareBurn(
    {
      mint: mintAddress,
      source,
      amount: BigInt(parsed.data.burn.amount),
      authority: signer.address,
    },
    parsed.data.options?.simulate ?? false
  );

  // Create transaction record with serialized tx
  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "burn",
    params: {
      source: parsed.data.burn.source,
      amount: parsed.data.burn.amount,
      memo: parsed.data.burn.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "burn",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: parsed.data.burn.source,
      amount: parsed.data.burn.amount,
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
    simulation: prepared.simulation,
  });
};

export const executeBurn = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = burnSchema.safeParse(body);

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
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to burn");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  // Get custody signer
  const signer = await createSigner(c.env);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.burn.source, "source");

  // Create transaction record first
  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "burn",
    params: {
      source: parsed.data.burn.source,
      amount: parsed.data.burn.amount,
      memo: parsed.data.burn.memo,
    },
    initiatedByKeyId: auth.id,
  });

  // Execute burn on Solana
  const token2022 = createToken2022Service(c.env);

  try {
    const result = await token2022.burn({
      mint: mintAddress,
      source,
      amount: BigInt(parsed.data.burn.amount),
      authority: signer,
    });

    // Update transaction with confirmation
    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    // Update token supply
    await tokenService.updateSupply(tokenId, parsed.data.burn.amount, "burn");

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "burn",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        source: parsed.data.burn.source,
        amount: parsed.data.burn.amount,
        signature: result.signature,
        slot: result.slot.toString(),
        mode: "execute",
      },
    });

    return success(c, { transaction: updatedTx });
  } catch (error) {
    // Update transaction as failed
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
