import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { getDb } from "@/db";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  assertApprovedWalletOperationCustodyWallet,
  beginApprovedWalletOperationEffect,
} from "@/services/policy/approved-operation-replay";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { forceBurnSchema } from "../schemas";
import {
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveDirectIssuanceReplay,
  resolvePermanentDelegateAuthority,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { assertJudgedCustodyWallet, buildIssuancePolicyCandidate } from "./policy";
import { toPublicTokenTransaction } from "./public-response";
import {
  isSettledIssuanceTransaction,
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

export const prepareForceBurn = async (c: ValidatedBodyContext<typeof forceBurnSchema>) => {
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

  assertTokenAllowsOperation(token, "force_burn");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(body.forceBurn.amount, token.decimals);

  const permanentDelegateRaw = await resolvePermanentDelegateAuthority(c.env, tokenService, token);
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }
  if (
    body.forceBurn.delegateAuthority !== undefined &&
    body.forceBurn.delegateAuthority !== permanentDelegateRaw
  ) {
    throw badRequest("Provided delegate authority does not match the on-chain authority");
  }

  const { signer, custodyWalletId } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    currentAuthority: permanentDelegateRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(body.forceBurn.source, "source");
  const permanentDelegate = assertValidAddress(permanentDelegateRaw, "delegateAuthority");

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const prepared = await mosaic.prepareForceBurn({
    mint: mintAddress,
    source,
    amount: mosaicAmount,
    permanentDelegate,
    feePayer: signer.address,
  });

  let simulation: unknown;
  if (body.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
    type: "force_burn",
    params: {
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: body.forceBurn.memo,
      supplyBaselineUpdatedAt: token.totalSupplyUpdatedAt ?? null,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "force_burn",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
      delegateAuthority: permanentDelegateRaw,
      mode: "prepare",
      custodyWalletId,
    },
  });

  return success(c, {
    transaction: toPublicTokenTransaction(tx),
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    simulation,
  });
};

export const executeForceBurn = async (c: ValidatedBodyContext<typeof forceBurnSchema>) => {
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
      operation: "force_burn",
      mode: "execute",
      params: { ...body, signingCustodyWalletId: custodyWalletId },
    });
  const earlyReplay = await resolveDirectIssuanceReplay({
    env: c.env,
    auth,
    tokenService,
    tokenId,
    type: "force_burn",
    idempotencyKey: c.req.header("Idempotency-Key"),
    requestedCustodyWalletId: body.signingCustodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
    fingerprintForCustodyWalletId: (custodyWalletId) =>
      idempotencyForWallet(custodyWalletId).idempotencyFingerprint,
  });
  if (earlyReplay) {
    const transaction = await recoverSettledTransactionReplay({
      auditService: new AuditService(getDb(c.env)),
      tokenService,
      transaction: earlyReplay,
      action: "force_burn",
    });
    if (approvedWalletOperationId(c) && !isSettledIssuanceTransaction(transaction)) {
      await beginApprovedWalletOperationEffect(c);
      throw conflict(
        "Approved force-burn execution is incomplete and requires manual reconciliation"
      );
    }
    if (transaction.status === "confirmed") {
      await tokenService.applySettledBurnSupply(transaction.id, tokenId, body.forceBurn.amount);
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }

  assertTokenAllowsOperation(token, "force_burn");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(body.forceBurn.amount, token.decimals);

  const permanentDelegateRaw = await resolvePermanentDelegateAuthority(c.env, tokenService, token);
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }
  if (
    body.forceBurn.delegateAuthority !== undefined &&
    body.forceBurn.delegateAuthority !== permanentDelegateRaw
  ) {
    throw badRequest("Provided delegate authority does not match the on-chain authority");
  }

  const { custodyWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    currentAuthority: permanentDelegateRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(body.forceBurn.source, "source");

  assertJudgedCustodyWallet(c, custodyWalletId);
  await assertApprovedWalletOperationCustodyWallet(c, custodyWalletId);

  const idempotencyMetadata = idempotencyForWallet(custodyWalletId);

  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId,
    tokenService,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
    type: "force_burn",
    params: {
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: body.forceBurn.memo,
      supplyBaselineUpdatedAt: token.totalSupplyUpdatedAt ?? null,
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
      action: "force_burn",
    });
    if (approvedWalletOperationId(c) && !isSettledIssuanceTransaction(transaction)) {
      await beginApprovedWalletOperationEffect(c);
      throw conflict(
        "Approved force-burn execution is incomplete and requires manual reconciliation"
      );
    }
    if (transaction.status === "confirmed") {
      await tokenService.applySettledBurnSupply(tx.id, tokenId, body.forceBurn.amount);
    }
    return success(c, { transaction: toPublicTokenTransaction(transaction) });
  }

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    custodyWalletId,
    currentAuthority: permanentDelegateRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "force_burn",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
      delegateAuthority: permanentDelegateRaw,
      mode: "execute",
      custodyWalletId,
    },
  });
  let onChainEffectCompleted = false;

  try {
    await beginApprovedWalletOperationEffect(c);
    const result = await mosaic.forceBurn({
      mint: mintAddress,
      source,
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

    await tokenService.applySettledBurnSupply(tx.id, tokenId, body.forceBurn.amount);

    return success(c, { transaction: toPublicTokenTransaction(updatedTx) });
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

export async function extractForceBurnPolicyCandidate(
  c: ValidatedBodyContext<typeof forceBurnSchema>
): Promise<PolicyGateExtraction> {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const body = c.req.valid("json");
  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({ tokenId, organizationId: orgId, projectId });
  if (!token) {
    throw notFound("Token");
  }

  const emptyExtraction = {
    legs: [],
    body,
    resolved: {},
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "force_burn",
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
    },
    idempotencyKey: null,
  };

  const idempotencyKey = c.req.header("Idempotency-Key");
  const replay = idempotencyKey
    ? await resolveDirectIssuanceReplay({
        env: c.env,
        auth,
        tokenService,
        tokenId,
        type: "force_burn",
        idempotencyKey,
        requestedCustodyWalletId: body.signingCustodyWalletId,
        requiredWalletPermissions: ["tokens:admin"],
        fingerprintForCustodyWalletId: (custodyWalletId) =>
          buildIdempotencyMetadata(idempotencyKey, {
            tokenId,
            operation: "force_burn",
            mode: "execute",
            params: { ...body, signingCustodyWalletId: custodyWalletId },
          }).idempotencyFingerprint,
      })
    : null;
  if (replay) {
    return { ...emptyExtraction, candidate: null };
  }

  assertTokenAllowsOperation(token, "force_burn");
  assertTokenIsDeployed(token);

  parsePositiveTokenAmount(body.forceBurn.amount, token.decimals);

  const permanentDelegateRaw = await resolvePermanentDelegateAuthority(c.env, tokenService, token);
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }
  if (
    body.forceBurn.delegateAuthority !== undefined &&
    body.forceBurn.delegateAuthority !== permanentDelegateRaw
  ) {
    throw badRequest("Provided delegate authority does not match the on-chain authority");
  }

  const { custodyWalletId, providerWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    currentAuthority: permanentDelegateRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });

  return {
    ...emptyExtraction,
    resolved: { judgedCustodyWalletId: custodyWalletId },
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId,
      walletId: providerWalletId,
      operationType: "issuance_force_burn_execute",
      amount: body.forceBurn.amount,
      destination: null,
    }),
  };
}
