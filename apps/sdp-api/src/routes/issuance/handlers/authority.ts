import { AuthorityType } from "@solana-program/token-2022";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService, type MosaicService } from "@/services/mosaic";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { updateAuthoritySchema } from "../schemas";
import {
  type AuthorityRole,
  resolveAuthoritySigner,
  resolveCurrentAuthorityForRole,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;
type MosaicAuthorityRole = Parameters<MosaicService["prepareUpdateAuthority"]>[0]["role"];

type AuthorityUpdate = {
  mintAuthority?: string | null;
  isMintable?: boolean;
  freezeAuthority?: string | null;
  isFreezable?: boolean;
  permanentDelegate?: string | null;
};

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
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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
    throw new AppError("BAD_REQUEST", "Current authority is not available for this token");
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
  const mosaic = createMosaicService(c.env, signer);

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
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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
    throw new AppError("BAD_REQUEST", "Current authority is not available for this token");
  }

  const { signer } = await resolveAuthoritySigner({
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

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "update_authority",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
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
  });

  if (replayed) {
    return success(c, { transaction: tx });
  }

  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.updateAuthority({
      mint: mintAddress,
      role: mapAuthorityRole(role),
      currentAuthority: signer,
      newAuthority,
      feePayer: signer,
    });

    const updatedTx = await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    const updates: AuthorityUpdate = {};
    if (role === "mint") {
      updates.mintAuthority = newAuthority;
      updates.isMintable = newAuthority !== null;
    }
    if (role === "freeze") {
      updates.freezeAuthority = newAuthority;
      updates.isFreezable = newAuthority !== null;
    }
    if (role === "permanentDelegate") {
      updates.permanentDelegate = newAuthority;
    }

    if (Object.keys(updates).length > 0) {
      await tokenService.updateTokenAuthorities(tokenId, updates);
    }

    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "update_authority",
      resourceType: "token_transaction",
      resourceId: tx.id,
      metadata: {
        tokenId,
        role,
        newAuthority,
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
