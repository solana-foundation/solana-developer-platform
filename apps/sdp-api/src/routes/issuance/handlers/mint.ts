import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { Context } from "hono";
import { mintSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

const toMosaicAmount = (amount: string): number => {
  const raw = BigInt(amount);
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError("BAD_REQUEST", "Amount is too large for Mosaic minting");
  }
  return Number(raw);
};

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

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  // Validation checks
  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to mint");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  if (!token.isMintable) {
    throw new AppError("TOKEN_NOT_MINTABLE", "Token is not mintable");
  }

  // Check allowlist if required
  if (token.requiresAllowlist) {
    const isAllowed = await tokenService.isAddressAllowed(tokenId, parsed.data.mint.destination);
    if (!isAllowed) {
      throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
    }
  }

  // Check max supply
  if (token.maxSupply) {
    const currentSupply = BigInt(token.totalSupply);
    const mintAmount = BigInt(parsed.data.mint.amount);
    const maxSupply = BigInt(token.maxSupply);

    if (currentSupply + mintAmount > maxSupply) {
      throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
    }
  }

  // Get mint authority (custody signer via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  const mintAuthority = assertValidAddress(token.mintAuthority ?? "", "mintAuthority");
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  // Build unsigned transaction using Mosaic
  // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
  const mosaic = createMosaicService(c.env, signer);
  const prepared = await mosaic.prepareMintTo({
    mint: mintAddress,
    destination,
    amount: toMosaicAmount(parsed.data.mint.amount),
    mintAuthority,
    feePayer: signer.address,
  });

  // Create transaction record with serialized tx
  const tx = await tokenService.createTransaction({
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
  const auditService = new AuditService(c.env.DB);
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

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  // Validation checks (same as prepare)
  if (token.status !== "active") {
    throw new AppError("TOKEN_NOT_ACTIVE", "Token must be active to mint");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  if (!token.isMintable) {
    throw new AppError("TOKEN_NOT_MINTABLE", "Token is not mintable");
  }

  if (token.requiresAllowlist) {
    const isAllowed = await tokenService.isAddressAllowed(tokenId, parsed.data.mint.destination);
    if (!isAllowed) {
      throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
    }
  }

  if (token.maxSupply) {
    const currentSupply = BigInt(token.totalSupply);
    const mintAmount = BigInt(parsed.data.mint.amount);
    const maxSupply = BigInt(token.maxSupply);

    if (currentSupply + mintAmount > maxSupply) {
      throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
    }
  }

  // Get custody signer (via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  // Create transaction record first
  const tx = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
    },
    initiatedByKeyId: auth.id,
  });

  // Execute mint on Solana using Mosaic
  // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.mintTo({
      mint: mintAddress,
      destination,
      amount: toMosaicAmount(parsed.data.mint.amount),
      mintAuthority: signer.address,
      feePayer: signer.address,
    });

    // Update transaction with confirmation
    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    // Update token supply
    await tokenService.updateSupply(tokenId, parsed.data.mint.amount, "mint");

    // Audit log
    const auditService = new AuditService(c.env.DB);
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
      transaction: updatedTx,
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
