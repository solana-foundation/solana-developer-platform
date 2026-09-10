import { createRpcForSdk } from "@sdp/rpc/solana";
import { type Address, assertValidAddress } from "@sdp/solana/address";
import { resolveTokenAccount } from "@solana/mosaic-sdk";
import { getDb } from "@/db";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceToken2022Service,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { burnSchema } from "../schemas";
import {
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  resolveDirectIssuanceReplay,
  resolveIssuanceWallet,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { toPublicTokenTransaction } from "./public-response";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

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

export const prepareBurn = async (c: ValidatedBodyContext<typeof burnSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const tokenService = getTenantTokenService(c);
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

  const wallet = await resolveIssuanceWallet({
    env: c.env,
    auth,
    custodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });
  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    custodyWalletId: wallet.custodyWalletId,
    currentAuthority: wallet.publicKey,
    requiredWalletPermissions: ["tokens:write"],
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(body.burn.source, "source");
  const { amountBaseUnits, mosaicAmount } = parsePositiveTokenAmount(
    body.burn.amount,
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
  const token2022 = createIssuanceToken2022Service(c, signer);
  const prepared = await (async () => {
    try {
      return await token2022.prepareBurn(
        {
          mint: mintAddress,
          source: normalizedSource,
          amount: mosaicAmount,
          authority: signer.address,
        },
        body.options?.simulate ?? false
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
    custodyWalletId: wallet.custodyWalletId,
    type: "burn",
    params: {
      source: body.burn.source,
      amount: body.burn.amount,
      memo: body.burn.memo,
      supplyBaselineUpdatedAt: token.totalSupplyUpdatedAt ?? null,
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
      source: body.burn.source,
      amount: body.burn.amount,
      mode: "prepare",
    },
  });

  return success(c, {
    transaction: toPublicTokenTransaction(tx),
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    simulation: prepared.simulation,
  });
};

export const executeBurn = async (c: ValidatedBodyContext<typeof burnSchema>) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = c.req.valid("json");

  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });

  if (!token) {
    throw notFound("Token");
  }

  const idempotencyForWallet = (custodyWalletId: string) =>
    buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
      tokenId,
      operation: "burn",
      mode: "execute",
      params: { ...body, signingCustodyWalletId: custodyWalletId },
    });
  const earlyReplay = await resolveDirectIssuanceReplay({
    env: c.env,
    auth,
    tokenService,
    tokenId,
    type: "burn",
    idempotencyKey: c.req.header("Idempotency-Key"),
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
    fingerprintForCustodyWalletId: (custodyWalletId) =>
      idempotencyForWallet(custodyWalletId).idempotencyFingerprint,
  });
  if (earlyReplay) {
    const transaction = await recoverSettledTransactionReplay({
      auditService: new AuditService(getDb(c.env)),
      tokenService,
      transaction: earlyReplay,
      action: "burn",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledBurnSupply(transaction.id, tokenId, body.burn.amount);
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }

  assertTokenAllowsOperation(token, "burn");
  assertTokenIsDeployed(token);

  const wallet = await resolveIssuanceWallet({
    env: c.env,
    auth,
    custodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(body.burn.source, "source");
  const { amountBaseUnits, mosaicAmount } = parsePositiveTokenAmount(
    body.burn.amount,
    token.decimals
  );

  const idempotencyMetadata = idempotencyForWallet(wallet.custodyWalletId);

  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId: wallet.custodyWalletId,
    tokenService,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
  });

  // Create transaction record first
  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId: wallet.custodyWalletId,
    type: "burn",
    params: {
      source: body.burn.source,
      amount: body.burn.amount,
      memo: body.burn.memo,
      supplyBaselineUpdatedAt: token.totalSupplyUpdatedAt ?? null,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const transaction = await recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: "burn",
    });
    if (transaction.status === "confirmed") {
      await tokenService.applySettledBurnSupply(tx.id, tokenId, body.burn.amount);
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }
  const auditIntent = await auditService.beginCritical(c, {
    action: "burn",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: body.burn.source,
      amount: body.burn.amount,
      mode: "execute",
    },
  });
  let onChainEffectCompleted = false;
  try {
    const signer = await createResolvedAuthoritySigner({
      env: c.env,
      auth,
      custodyWalletId: wallet.custodyWalletId,
      currentAuthority: wallet.publicKey,
      requiredWalletPermissions: ["tokens:write"],
    });
    const normalizedSource = await resolveValidatedBurnSource(
      c.env,
      signer.address,
      source,
      mintAddress,
      amountBaseUnits,
      token.symbol
    );

    // Execute burn on Solana
    const token2022 = createIssuanceToken2022Service(c, signer);

    const result = await token2022.burn({
      mint: mintAddress,
      source: normalizedSource,
      amount: mosaicAmount,
      authority: signer,
    });
    onChainEffectCompleted = true;

    const evidence = { signature: result.signature, slot: Number(result.slot) };

    // Persist the settlement first so an audit-outcome outage cannot leave a
    // completed operation looking pending. If this write is unavailable, the
    // independent audit outcome below remains the replay-recovery fallback.
    const updatedTx = await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence,
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: result.signature,
            slot: result.slot.toString(),
          },
        }),
    });

    // Update token supply
    await tokenService.applySettledBurnSupply(tx.id, tokenId, body.burn.amount);

    emitTokenOperationCompleted(c, {
      organizationId: orgId,
      projectId,
      tokenId,
      operation: "burn",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    return success(c, { transaction: toPublicTokenTransaction(updatedTx) });
  } catch (error) {
    if (!onChainEffectCompleted) {
      await auditService.completeCritical(c, auditIntent, {
        status: "failure",
        metadata: {
          error:
            toBurnOperationAppError(error)?.message ??
            (error instanceof Error ? error.message : "Unknown error"),
        },
      });
      await tokenService.updateTransaction(tx.id, {
        status: "failed",
        error:
          toBurnOperationAppError(error)?.message ??
          (error instanceof Error ? error.message : "Unknown error"),
      });
    }

    const appError = toBurnOperationAppError(error);
    if (appError) {
      throw appError;
    }

    throw error;
  }
};
