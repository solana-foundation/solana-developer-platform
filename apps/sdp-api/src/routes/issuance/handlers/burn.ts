import { resolveTokenAccount } from "@solana/mosaic-sdk";
import type { Context } from "hono";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { type Address, assertValidAddress } from "@/lib/solana";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner, createToken2022Service } from "@/services/solana";
import { createRpcForSdk } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import { requireProjectScope } from "../helpers";
import { burnSchema } from "../schemas";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;
type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

function toBurnOperationAppError(error: unknown): AppError | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (error.message.startsWith("Burn source must be the authority wallet")) {
    return new AppError(
      "INVALID_BURN_SOURCE",
      "Standard burn only supports the selected signer wallet or its token account. Use force-burn for a different account.",
      {
        field: "source",
        hint: "Choose the signer wallet as the source, or use force-burn for a different account.",
      }
    );
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
      "No token holding account was found for this mint. Provide the signer wallet or its token account.",
      {
        field: "source",
        hint: "Use the selected signer wallet address, or provide its token account for this mint.",
      }
    );
  }

  return null;
}

async function resolveValidatedBurnSource(
  env: Env,
  authorityAddress: Address,
  requestedSource: Address,
  mintAddress: Address,
  amountBaseUnits: bigint,
  tokenSymbol: string
): Promise<Address> {
  const rpc = createRpcForSdk<MosaicSdkRpc>(env);

  let authorityAta: Awaited<ReturnType<typeof resolveTokenAccount>>;
  try {
    authorityAta = await resolveTokenAccount(rpc, authorityAddress, mintAddress);
  } catch (error) {
    const appError = toBurnOperationAppError(error);
    if (appError) {
      throw appError;
    }
    throw error;
  }

  if (!authorityAta.isInitialized) {
    throw new AppError(
      "TOKEN_ACCOUNT_NOT_FOUND",
      "The selected signer wallet does not currently hold this token.",
      {
        field: "source",
        hint: "Burn uses the signer wallet's token account. Mint or receive tokens into that wallet first, or use force-burn for a different account.",
      }
    );
  }

  const normalizedSource =
    requestedSource === authorityAddress ? authorityAta.tokenAccount : requestedSource;

  if (normalizedSource !== authorityAta.tokenAccount) {
    throw new AppError(
      "INVALID_BURN_SOURCE",
      "Standard burn only supports the selected signer wallet or its token account. Use force-burn for a different account.",
      {
        field: "source",
        hint: "Choose the signer wallet as the source, or use force-burn for another wallet or token account.",
      }
    );
  }

  if (authorityAta.balance < amountBaseUnits) {
    throw new AppError(
      "INSUFFICIENT_TOKEN_BALANCE",
      `The selected signer wallet only holds ${authorityAta.uiBalance} ${tokenSymbol}.`,
      {
        field: "amount",
        available: authorityAta.uiBalance.toString(),
        hint: "Lower the burn amount, fund this wallet first, or use force-burn for a different account.",
      }
    );
  }

  return normalizedSource;
}

export const prepareBurn = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = burnSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
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

  assertTokenAllowsOperation(token, "burn");
  assertTokenIsDeployed(token);

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Validate addresses and get custody authority (via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.burn.source, "source");
  const { amountBaseUnits, mosaicAmount } = parsePositiveTokenAmount(
    parsed.data.burn.amount,
    token.decimals
  );
  const normalizedSource = await resolveValidatedBurnSource(
    c.env,
    signer.address,
    source,
    mintAddress,
    amountBaseUnits,
    token.symbol
  );

  // Build unsigned transaction
  const token2022 = createToken2022Service(c.env, signer);
  const prepared = await (async () => {
    try {
      return await token2022.prepareBurn(
        {
          mint: mintAddress,
          source: normalizedSource,
          amount: mosaicAmount,
          authority: signer.address,
        },
        parsed.data.options?.simulate ?? false
      );
    } catch (error) {
      const appError = toBurnOperationAppError(error);
      if (appError) {
        throw appError;
      }
      throw error;
    }
  })();

  // Create transaction record with serialized tx
  const { transaction: tx } = await tokenService.createTransaction({
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
  const auditService = new AuditService(getDb(c.env));
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
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = burnSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
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

  assertTokenAllowsOperation(token, "burn");
  assertTokenIsDeployed(token);

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(parsed.data.burn.source, "source");
  const { amountBaseUnits, mosaicAmount } = parsePositiveTokenAmount(
    parsed.data.burn.amount,
    token.decimals
  );

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "burn",
    mode: "execute",
    params: parsed.data,
  });

  // Create transaction record first
  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "burn",
    params: {
      source: parsed.data.burn.source,
      amount: parsed.data.burn.amount,
      memo: parsed.data.burn.memo,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (replayed) {
    return success(c, { transaction: tx });
  }
  try {
    // Get custody signer (via 3-tier resolution)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );
    const normalizedSource = await resolveValidatedBurnSource(
      c.env,
      signer.address,
      source,
      mintAddress,
      amountBaseUnits,
      token.symbol
    );

    // Execute burn on Solana
    const token2022 = createToken2022Service(c.env, signer);

    const result = await token2022.burn({
      mint: mintAddress,
      source: normalizedSource,
      amount: mosaicAmount,
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
    const auditService = new AuditService(getDb(c.env));
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
      error:
        toBurnOperationAppError(error)?.message ??
        (error instanceof Error ? error.message : "Unknown error"),
    });

    const appError = toBurnOperationAppError(error);
    if (appError) {
      throw appError;
    }

    throw error;
  }
};
