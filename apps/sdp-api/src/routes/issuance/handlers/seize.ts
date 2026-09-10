import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
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
import type { seizeSchema } from "../schemas";
import { assertDestinationAllowedByControlList } from "./access-control";
import {
  createResolvedAuthoritySigner,
  persistDiscoveredPermanentDelegate,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolvePermanentDelegateAuthority,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { buildIssuancePolicyCandidate } from "./policy";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

export const prepareSeize = async (c: ValidatedBodyContext<typeof seizeSchema>) => {
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

  assertTokenAllowsOperation(token, "seize");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(body.seize.amount, token.decimals);

  const isOnControlList = await tokenService.isAddressAllowed(tokenId, body.seize.destination);
  assertDestinationAllowedByControlList({
    token,
    destination: body.seize.destination,
    isOnControlList,
  });

  const permanentDelegateRaw =
    body.seize.delegateAuthority ??
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
  const source = assertValidAddress(body.seize.source, "source");
  const destination = assertValidAddress(body.seize.destination, "destination");
  const permanentDelegate = assertValidAddress(permanentDelegateRaw, "delegateAuthority");

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const prepared = await mosaic.prepareForceTransfer({
    mint: mintAddress,
    source,
    destination,
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
    type: "seize",
    params: {
      source: body.seize.source,
      destination: body.seize.destination,
      amount: body.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: body.seize.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
  });

  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "seize",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: body.seize.source,
      destination: body.seize.destination,
      amount: body.seize.amount,
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

type SeizeBody = z.output<typeof seizeSchema>;

interface SeizePolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  projectId: string;
  tokenService: TokenService;
  mosaicAmount: number;
  permanentDelegateRaw: string;
  cachedPermanentDelegate: string | null;
  walletId: string;
  mintAddress: ReturnType<typeof assertValidAddress>;
  source: ReturnType<typeof assertValidAddress>;
  destination: ReturnType<typeof assertValidAddress>;
}

export async function extractSeizePolicyCandidate(
  c: ValidatedBodyContext<typeof seizeSchema>
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

  assertTokenAllowsOperation(token, "seize");
  assertTokenIsDeployed(token);

  const { mosaicAmount } = parsePositiveTokenAmount(body.seize.amount, token.decimals);

  const isOnControlList = await tokenService.isAddressAllowed(tokenId, body.seize.destination);
  assertDestinationAllowedByControlList({
    token,
    destination: body.seize.destination,
    isOnControlList,
  });

  const permanentDelegateRaw =
    body.seize.delegateAuthority ??
    (await resolvePermanentDelegateAuthority(c.env, tokenService, token, {
      persistDiscovery: false,
    }));
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
  const source = assertValidAddress(body.seize.source, "source");
  const destination = assertValidAddress(body.seize.destination, "destination");
  const policyWallet = await resolvePolicyCustodyWallet(c.env, auth, walletId);

  return {
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId: policyWallet === null ? null : policyWallet.id,
      walletId,
      operationType: "issuance_seize_execute",
      amount: body.seize.amount,
      destination: body.seize.destination,
    }),
    legs: [],
    body,
    resolved: {
      tokenId,
      auth,
      projectId,
      tokenService,
      mosaicAmount,
      permanentDelegateRaw,
      cachedPermanentDelegate: token.extensions?.permanentDelegate ?? null,
      walletId,
      mintAddress,
      source,
      destination,
    } satisfies SeizePolicyResolved,
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "seize",
      source: body.seize.source,
      destination: body.seize.destination,
      amount: body.seize.amount,
    },
    idempotencyKey: null,
  };
}

export const executeSeize = async (c: ValidatedBodyContext<typeof seizeSchema>) => {
  const {
    body,
    resolved: {
      tokenId,
      auth,
      projectId,
      tokenService,
      mosaicAmount,
      permanentDelegateRaw,
      cachedPermanentDelegate,
      walletId,
      mintAddress,
      source,
      destination,
    },
  } = getPolicyGateContext<SeizeBody, SeizePolicyResolved, WalletOperationPolicyEnforcement | null>(
    c
  );

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    walletId,
    currentAuthority: permanentDelegateRaw,
  });

  await persistDiscoveredPermanentDelegate(
    tokenService,
    tokenId,
    cachedPermanentDelegate,
    permanentDelegateRaw
  );

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "seize",
    mode: "execute",
    params: body,
  });

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "seize",
    params: {
      source: body.seize.source,
      destination: body.seize.destination,
      amount: body.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      memo: body.seize.memo,
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
      action: "seize",
    });
    return success(c, { transaction });
  }

  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "seize",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      source: body.seize.source,
      destination: body.seize.destination,
      amount: body.seize.amount,
      delegateAuthority: permanentDelegateRaw,
      mode: "execute",
    },
  });
  let onChainEffectCompleted = false;

  try {
    const result = await mosaic.forceTransfer({
      mint: mintAddress,
      source,
      destination,
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

    emitTokenOperationCompleted(c, {
      organizationId: auth.organizationId,
      projectId,
      tokenId,
      operation: "seize",
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
