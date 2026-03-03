import { resolveApiKeySigningWalletId } from "@/lib/api-key-wallet-auth";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, paginated, success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import type { FrozenAccountResponse } from "@sdp/types";
import type { Context } from "hono";
import { freezeSchema, unfreezeSchema } from "../schemas";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;

export const freezeAccount = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = freezeSchema.safeParse(body);

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

  if (!token.isFreezable) {
    throw new AppError("BAD_REQUEST", "Token does not support freeze operations");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const signingWalletId = resolveApiKeySigningWalletId(auth, undefined, ["tokens:admin"]);

  // Get custody signer (freeze authority, via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const accountAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "freeze",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "freeze",
    params: {
      accountAddress: parsed.data.accountAddress,
      reason: parsed.data.reason,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  if (replayed) {
    if (tx.status === "failed") {
      throw new AppError("BAD_REQUEST", tx.error ?? "Previous freeze request failed");
    }

    const latestRecord = await tokenService.getFrozenAccount(
      tokenId,
      parsed.data.accountAddress,
      true
    );
    if (!latestRecord) {
      throw new AppError("NOT_FOUND", "Replay transaction has no matching account record");
    }

    return created(c, {
      frozenAccount: {
        ...latestRecord,
        signature: tx.signature ?? undefined,
      },
    });
  }

  // Execute freeze on Solana first (Token ACL-aware via Mosaic)
  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.freezeAccount({
      tokenAccount: accountAddress,
      feePayer: signer.address,
    });

    // Record in database after successful on-chain operation
    const frozenAccount = await tokenService.freezeAccount({
      tokenId,
      accountAddress: parsed.data.accountAddress,
      frozenBy: auth.id,
      reason: parsed.data.reason,
    });

    // Create transaction record for the freeze operation
    await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
      params: {
        accountAddress: parsed.data.accountAddress,
        reason: parsed.data.reason,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "freeze",
      resourceType: "frozen_account",
      resourceId: frozenAccount.id,
      metadata: {
        tokenId,
        accountAddress: parsed.data.accountAddress,
        reason: parsed.data.reason,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    const response: FrozenAccountResponse = {
      frozenAccount: {
        ...frozenAccount,
        signature: result.signature,
      },
    };
    return created(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_ALREADY_FROZEN") {
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error.message,
      });
      throw new AppError("ACCOUNT_FROZEN", "Account is already frozen");
    }
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};

export const listFrozenAccounts = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const tokenService = new TokenService(c.env.DB);
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (auth?.projectId && token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const page = Number.parseInt(c.req.query("page") ?? "1", 10);
  const pageSize = Math.min(Number.parseInt(c.req.query("pageSize") ?? "50", 10), 100);
  const offset = (page - 1) * pageSize;

  const { frozenAccounts, total } = await tokenService.listFrozenAccounts(tokenId, {
    limit: pageSize,
    offset,
  });

  return paginated(c, frozenAccounts, { total, page, pageSize });
};

export const unfreezeAccount = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = unfreezeSchema.safeParse(body);

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

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const frozen = await tokenService.isAccountFrozen(tokenId, parsed.data.accountAddress);
  if (!frozen) {
    throw new AppError("ACCOUNT_NOT_FROZEN", "Account is not frozen");
  }

  const signingWalletId = resolveApiKeySigningWalletId(auth, undefined, ["tokens:admin"]);

  // Get custody signer (freeze authority, via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const accountAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "unfreeze",
    mode: "execute",
    params: parsed.data,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "unfreeze",
    params: {
      accountAddress: parsed.data.accountAddress,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  if (replayed) {
    if (tx.status === "failed") {
      throw new AppError("BAD_REQUEST", tx.error ?? "Previous unfreeze request failed");
    }

    const latestRecord = await tokenService.getFrozenAccount(
      tokenId,
      parsed.data.accountAddress,
      true
    );
    if (latestRecord) {
      return success(c, {
        frozenAccount: {
          ...latestRecord,
          signature: tx.signature ?? undefined,
        },
      });
    }

    throw new AppError("NOT_FOUND", "Replay transaction has no matching account record");
  }

  // Execute thaw on Solana first (Token ACL-aware via Mosaic)
  const mosaic = createMosaicService(c.env, signer);

  try {
    const result = await mosaic.thawAccount({
      tokenAccount: accountAddress,
      feePayer: signer.address,
    });

    // Update database record after successful on-chain operation
    const frozenAccount = await tokenService.unfreezeAccount(
      tokenId,
      parsed.data.accountAddress,
      auth.id
    );

    await tokenService.updateTransaction(tx.id, {
      status: "confirmed",
      signature: result.signature,
      slot: Number(result.slot),
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "unfreeze",
      resourceType: "frozen_account",
      resourceId: frozenAccount.id,
      metadata: {
        tokenId,
        accountAddress: parsed.data.accountAddress,
        signature: result.signature,
        slot: result.slot.toString(),
      },
    });

    const response: FrozenAccountResponse = {
      frozenAccount: {
        ...frozenAccount,
        signature: result.signature,
      },
    };
    return success(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_NOT_FROZEN") {
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: error.message,
      });
      throw new AppError("ACCOUNT_NOT_FROZEN", "Account is not frozen");
    }
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
