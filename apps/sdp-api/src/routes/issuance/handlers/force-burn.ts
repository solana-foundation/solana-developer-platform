import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { resolvePolicyCustodyWallet } from "@/services/policy/enforcement.service";
import type { TokenService } from "@/services/token.service";
import {
  assertTokenAllowsOperation,
  assertTokenIsDeployed,
  parsePositiveTokenAmount,
} from "@/services/token-operation.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { forceBurnSchema } from "../schemas";
import {
  createResolvedAuthoritySigner,
  resolveAuthoritySigner,
  resolvePermanentDelegateAuthority,
  resolveAuthorityWallet,
} from "./authority-resolution";
import { buildIssuancePolicyCandidate } from "./policy";
import { buildIdempotencyMetadata } from "./idempotency";
import {
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

  const permanentDelegateRaw =
    body.forceBurn.delegateAuthority ??
    (await resolvePermanentDelegateAuthority(c.env, tokenService, token));
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }

  const { signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    token,
    requestedWalletId: body.signingWalletId,
    currentAuthority: permanentDelegateRaw,
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

type ForceBurnBody = z.output<typeof forceBurnSchema>;

interface ForceBurnPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  projectId: string;
  tokenService: TokenService;
  supplyBaselineUpdatedAt: string | null;
  mosaicAmount: number;
  permanentDelegateRaw: string;
  walletId: string;
  mintAddress: ReturnType<typeof assertValidAddress>;
  source: ReturnType<typeof assertValidAddress>;
}

export async function extractForceBurnPolicyCandidate(
  c: ValidatedBodyContext<typeof forceBurnSchema>
): Promise<PolicyGateExtraction> {
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

  const permanentDelegateRaw =
    body.forceBurn.delegateAuthority ??
    (await resolvePermanentDelegateAuthority(c.env, tokenService, token));
  if (!permanentDelegateRaw) {
    throw badRequest("Permanent delegate is not configured for this token");
  }

  const { walletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    token,
    requestedWalletId: body.signingWalletId,
    currentAuthority: permanentDelegateRaw,
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const source = assertValidAddress(body.forceBurn.source, "source");
  const policyWallet = await resolvePolicyCustodyWallet(c.env, auth, walletId);

  return {
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId: policyWallet === null ? null : policyWallet.id,
      walletId,
      operationType: "issuance_force_burn_execute",
      amount: body.forceBurn.amount,
      destination: null,
    }),
    legs: [],
    body,
    resolved: {
      tokenId,
      auth,
      projectId,
      tokenService,
      supplyBaselineUpdatedAt: token.totalSupplyUpdatedAt ?? null,
      mosaicAmount,
      permanentDelegateRaw,
      walletId,
      mintAddress,
      source,
    } satisfies ForceBurnPolicyResolved,
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "force_burn",
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
    },
    idempotencyKey: null,
  };
}

export const executeForceBurn = async (c: ValidatedBodyContext<typeof forceBurnSchema>) => {
  const {
    body,
    resolved: {
      tokenId,
      auth,
      projectId,
      tokenService,
      supplyBaselineUpdatedAt,
      mosaicAmount,
      permanentDelegateRaw,
      walletId,
      mintAddress,
      source,
    },
  } = getPolicyGateContext<
    ForceBurnBody,
    ForceBurnPolicyResolved,
    WalletOperationPolicyEnforcement | null
  >(c);

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    walletId,
    currentAuthority: permanentDelegateRaw,
  });

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "force_burn",
    mode: "execute",
    params: body,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "force_burn",
    params: {
      source: body.forceBurn.source,
      amount: body.forceBurn.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: body.forceBurn.memo,
      supplyBaselineUpdatedAt,
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
    if (transaction.status === "confirmed") {
      await tokenService.applySettledBurnSupply(tx.id, tokenId, body.forceBurn.amount);
    }
    return success(c, { transaction });
  }

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
    },
  });
  let onChainEffectCompleted = false;

  try {
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

    emitTokenOperationCompleted(c, {
      organizationId: auth.organizationId,
      projectId,
      tokenId,
      operation: "force_burn",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    return success(c, { transaction: updatedTx });
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
