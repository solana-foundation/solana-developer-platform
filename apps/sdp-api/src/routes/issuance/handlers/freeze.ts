import { createRpcForSdk } from "@sdp/rpc/solana";
import { type Address, assertValidAddress } from "@sdp/solana/address";
import type { FrozenAccount, FrozenAccountResponse, TokenTransaction } from "@sdp/types";
import { resolveTokenAccount } from "@solana/mosaic-sdk";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { created, paginated, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import type { TokenService } from "@/services/token.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { freezeSchema, unfreezeSchema } from "../schemas";
import { getTokenAccessControlMode, type TokenAccessControlMode } from "./access-control";
import { resolveAuthoritySigner, resolveCurrentAuthorityForRole } from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

async function recoverFreezeAccountReplay(options: {
  auditService: AuditService;
  tokenService: TokenService;
  transaction: TokenTransaction;
  tokenId: string;
  tokenAccount: string;
  actorId: string;
  reason?: string;
}): Promise<{ transaction: TokenTransaction; frozenAccount: FrozenAccount }> {
  const transaction = await recoverSettledTransactionReplay({
    auditService: options.auditService,
    tokenService: options.tokenService,
    transaction: options.transaction,
    action: "freeze",
    params: {
      accountAddress: options.tokenAccount,
      reason: options.reason,
      tokenAccountAddress: options.tokenAccount,
    },
  });
  if (transaction.status === "failed") {
    throw badRequest(transaction.error ?? "Previous freeze request failed");
  }

  const frozenAccount =
    transaction.status === "confirmed"
      ? await options.tokenService.applySettledAccountFreezeState({
          transactionId: transaction.id,
          tokenId: options.tokenId,
          accountAddress: options.tokenAccount,
          state: "frozen",
          actorId: options.actorId,
          reason: options.reason,
        })
      : await options.tokenService.getFrozenAccount(options.tokenId, options.tokenAccount, true);
  if (!frozenAccount) {
    throw new AppError("NOT_FOUND", "Replay transaction has no matching account record");
  }
  return { transaction, frozenAccount };
}

async function recoverUnfreezeAccountReplay(options: {
  auditService: AuditService;
  tokenService: TokenService;
  transaction: TokenTransaction;
  tokenId: string;
  tokenAccount: string;
  actorId: string;
}): Promise<{ transaction: TokenTransaction; frozenAccount: FrozenAccount }> {
  const transaction = await recoverSettledTransactionReplay({
    auditService: options.auditService,
    tokenService: options.tokenService,
    transaction: options.transaction,
    action: "unfreeze",
  });
  if (transaction.status === "failed") {
    throw badRequest(transaction.error ?? "Previous unfreeze request failed");
  }

  const frozenAccount =
    transaction.status === "confirmed"
      ? await options.tokenService.applySettledAccountFreezeState({
          transactionId: transaction.id,
          tokenId: options.tokenId,
          accountAddress: options.tokenAccount,
          state: "unfrozen",
          actorId: options.actorId,
        })
      : await options.tokenService.getFrozenAccount(options.tokenId, options.tokenAccount, true);
  if (!frozenAccount) {
    throw new AppError("NOT_FOUND", "Replay transaction has no matching account record");
  }
  return { transaction, frozenAccount };
}

function getMissingTokenAccountHint(accessControlMode: TokenAccessControlMode): string {
  if (accessControlMode === "blocklist") {
    return "Use a wallet that already holds this token, provide the matching token account address, or add the wallet to the token denylist first.";
  }

  return "Use a wallet that already holds this token, or provide the matching token account address.";
}

function toFreezeOperationAppError(
  error: unknown,
  accessControlMode: TokenAccessControlMode
): AppError | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (
    error.message === "Token account not found" ||
    error.message === "Failed to parse token account data" ||
    error.message.startsWith("Unable to parse token account data") ||
    error.message.includes("is not a valid account for mint") ||
    error.message.includes("is not for mint")
  ) {
    return new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "No token holding account was found for this mint. Provide a wallet address that holds this token or the matching token account.",
      {
        field: "accountAddress",
        hint: getMissingTokenAccountHint(accessControlMode),
      }
    );
  }

  return null;
}

function readParsedTokenAccountOwner(data: unknown): string | null {
  if (!data || typeof data !== "object" || !("parsed" in data)) {
    return null;
  }

  const parsed = data.parsed;
  if (!parsed || typeof parsed !== "object" || !("info" in parsed)) {
    return null;
  }

  const info = parsed.info;
  if (!info || typeof info !== "object" || !("owner" in info)) {
    return null;
  }

  return typeof info.owner === "string" ? info.owner : null;
}

async function resolveFreezeTarget(
  env: Env,
  requestedAddress: Address,
  mintAddress: Address,
  accessControlMode: TokenAccessControlMode
): Promise<{ tokenAccount: Address }> {
  const rpc = createRpcForSdk<MosaicSdkRpc>(env);
  const resolved = await resolveTokenAccount(rpc, requestedAddress, mintAddress);

  if (!resolved.isInitialized) {
    throw new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "This wallet does not currently have a token account for this mint.",
      {
        field: "accountAddress",
        hint: getMissingTokenAccountHint(accessControlMode),
      }
    );
  }

  if (resolved.tokenAccount !== requestedAddress) {
    return {
      tokenAccount: resolved.tokenAccount,
    };
  }

  const accountInfo = await rpc
    .getAccountInfo(resolved.tokenAccount, { encoding: "jsonParsed" })
    .send();
  const owner = readParsedTokenAccountOwner(accountInfo.value?.data);

  if (!owner) {
    throw new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "Unable to determine the owner wallet for this token account.",
      {
        field: "accountAddress",
        hint:
          accessControlMode === "blocklist"
            ? "Provide a wallet that already holds this token, verify that the token account address is correct for this mint, or use the denylist to block a wallet before it receives tokens."
            : "Provide a wallet that already holds this token, or verify that the token account address is correct for this mint.",
      }
    );
  }

  assertValidAddress(owner, "accountAddress");

  return {
    tokenAccount: resolved.tokenAccount,
  };
}

export const freezeAccount = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = freezeSchema.safeParse(body);

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

  if (!token.isFreezable) {
    throw badRequest("Token does not support freeze operations");
  }

  if (!token.mintAddress) {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const accessControlMode = getTokenAccessControlMode(token);
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    "freeze"
  );

  if (!currentAuthorityRaw) {
    throw badRequest("Current freeze authority is not available for this token");
  }

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: currentAuthorityRaw,
  });
  const requestedAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");
  const { tokenAccount } = await resolveFreezeTarget(
    c.env,
    requestedAddress,
    mintAddress,
    accessControlMode
  );

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "freeze",
    mode: "execute",
    params: {
      ...parsed.data,
      accountAddress: tokenAccount,
    },
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "freeze",
    params: {
      accountAddress: tokenAccount,
      reason: parsed.data.reason,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const replay = await recoverFreezeAccountReplay({
      auditService,
      tokenService,
      transaction: tx,
      tokenId,
      tokenAccount,
      actorId: auth.id,
      reason: parsed.data.reason,
    });
    return created(c, {
      frozenAccount: {
        ...replay.frozenAccount,
        signature: replay.transaction.signature ?? undefined,
      },
    });
  }

  // Execute freeze on Solana first (Token ACL-aware via Mosaic)
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "freeze",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      accountAddress: tokenAccount,
      tokenAccountAddress: tokenAccount,
      reason: parsed.data.reason,
    },
  });
  let onChainEffectCompleted = false;

  try {
    const result = await mosaic.freezeAccount({
      tokenAccount,
      feePayer: signer.address,
    });
    onChainEffectCompleted = true;

    await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence: { signature: result.signature, slot: Number(result.slot) },
      params: {
        accountAddress: tokenAccount,
        reason: parsed.data.reason,
        tokenAccountAddress: tokenAccount,
        signature: result.signature,
        slot: result.slot.toString(),
      },
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: result.signature,
            slot: result.slot.toString(),
          },
        }),
    });

    // Record in database after durable settlement evidence exists.
    const frozenAccount = await tokenService.applySettledAccountFreezeState({
      transactionId: tx.id,
      tokenId,
      accountAddress: tokenAccount,
      state: "frozen",
      actorId: auth.id,
      reason: parsed.data.reason,
    });

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "freeze",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    const response: FrozenAccountResponse = {
      frozenAccount: {
        ...frozenAccount,
        signature: result.signature,
      },
    };
    return created(c, response);
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
      if (error instanceof Error && error.message === "ACCOUNT_ALREADY_FROZEN") {
        await tokenService.updateTransaction(tx.id, {
          status: "failed",
          error: error.message,
        });
        throw new AppError("ACCOUNT_FROZEN", "Account is already frozen");
      }

      const mappedError = toFreezeOperationAppError(error, accessControlMode);
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: mappedError?.message ?? (error instanceof Error ? error.message : "Unknown error"),
      });
      if (mappedError) {
        throw mappedError;
      }
    }
    throw error;
  }
};

export const listFrozenAccounts = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { projectId, orgId } = requireProjectScope(c);

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
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
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = unfreezeSchema.safeParse(body);

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

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const accessControlMode = getTokenAccessControlMode(token);
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    "freeze"
  );

  if (!currentAuthorityRaw) {
    throw badRequest("Current freeze authority is not available for this token");
  }

  const requestedAddress = assertValidAddress(parsed.data.accountAddress, "accountAddress");
  const { tokenAccount } = await resolveFreezeTarget(
    c.env,
    requestedAddress,
    mintAddress,
    accessControlMode
  );

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: parsed.data.signingWalletId,
    currentAuthority: currentAuthorityRaw,
  });

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "unfreeze",
    mode: "execute",
    params: {
      ...parsed.data,
      accountAddress: tokenAccount,
    },
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "unfreeze",
    params: {
      accountAddress: tokenAccount,
    },
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const replay = await recoverUnfreezeAccountReplay({
      auditService,
      tokenService,
      transaction: tx,
      tokenId,
      tokenAccount,
      actorId: auth.id,
    });
    return success(c, {
      frozenAccount: {
        ...replay.frozenAccount,
        signature: replay.transaction.signature ?? undefined,
      },
    });
  }

  const frozen = await tokenService.isAccountFrozen(tokenId, tokenAccount);
  if (!frozen) {
    throw new AppError("ACCOUNT_NOT_FROZEN", "Account is not frozen");
  }

  // Execute thaw on Solana first (Token ACL-aware via Mosaic)
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "unfreeze",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      accountAddress: tokenAccount,
      tokenAccountAddress: tokenAccount,
    },
  });
  let onChainEffectCompleted = false;

  try {
    const result = await mosaic.thawAccount({
      tokenAccount,
      feePayer: signer.address,
    });
    onChainEffectCompleted = true;

    await persistSettledTransactionThenOutcome({
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

    // Update database record after durable settlement evidence exists.
    const frozenAccount = await tokenService.applySettledAccountFreezeState({
      transactionId: tx.id,
      tokenId,
      accountAddress: tokenAccount,
      state: "unfrozen",
      actorId: auth.id,
    });

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "unfreeze",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    const response: FrozenAccountResponse = {
      frozenAccount: {
        ...frozenAccount,
        signature: result.signature,
      },
    };
    return success(c, response);
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: { error: error instanceof Error ? error.message : "Unknown error" },
      });
      if (error instanceof Error && error.message === "ACCOUNT_NOT_FROZEN") {
        await tokenService.updateTransaction(tx.id, {
          status: "failed",
          error: error.message,
        });
        throw new AppError("ACCOUNT_NOT_FROZEN", "Account is not frozen");
      }

      const mappedError = toFreezeOperationAppError(error, accessControlMode);
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error: mappedError?.message ?? (error instanceof Error ? error.message : "Unknown error"),
      });
      if (mappedError) {
        throw mappedError;
      }
    }
    throw error;
  }
};
