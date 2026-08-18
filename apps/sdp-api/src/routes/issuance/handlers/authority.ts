import type { MosaicService } from "@sdp/issuance/mosaic/service";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import { AuthorityType } from "@solana-program/token-2022";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import { AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import { resolvePolicyCustodyWallet } from "@/services/policy/enforcement.service";
import type { TokenService } from "@/services/token.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { updateAuthoritySchema } from "../schemas";
import {
  type AuthorityRole,
  createResolvedAuthoritySigner,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { buildIssuancePolicyCandidate } from "./policy";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicAuthorityRole = Parameters<MosaicService["prepareUpdateAuthority"]>[0]["role"];
type UpdateAuthorityBody = z.output<typeof updateAuthoritySchema>;

interface UpdateAuthorityPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  role: AuthorityRole;
  currentAuthorityRaw: string;
  walletId: string;
  mintAddress: ReturnType<typeof assertValidAddress>;
  newAuthority: ReturnType<typeof assertValidAddress> | null;
}

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
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = updateAuthoritySchema.safeParse(body);

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
    throw badRequest("Current authority is not available for this token");
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
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

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

/**
 * Parse and resolve an authority update into its wallet-operation policy candidate.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resolved resources, and raw payload.
 */
export async function extractUpdateAuthorityPolicyCandidate(
  c: AppContext
): Promise<PolicyGateExtraction> {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const parsed = updateAuthoritySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const input = parsed.data;
  const tokenService = getTenantTokenService(c);
  const token = await tokenService.getToken({
    tokenId,
    organizationId: orgId,
    projectId,
  });
  if (!token) {
    throw notFound("Token");
  }
  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = input.authority.role;
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    role,
    input.authority.currentAuthority
  );
  if (!currentAuthorityRaw) {
    throw badRequest("Current authority is not available for this token");
  }

  const { walletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    token,
    requestedWalletId: input.signingWalletId,
    currentAuthority: currentAuthorityRaw,
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const newAuthority = input.authority.newAuthority
    ? assertValidAddress(input.authority.newAuthority, "newAuthority")
    : null;
  const policyWallet = await resolvePolicyCustodyWallet(c.env, auth, walletId);

  return {
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId: policyWallet === null ? null : policyWallet.id,
      walletId,
      operationType: "issuance_update_authority_execute",
      amount: null,
      destination: newAuthority,
    }),
    legs: [],
    body: input,
    resolved: {
      tokenId,
      auth,
      tokenService,
      role,
      currentAuthorityRaw,
      walletId,
      mintAddress,
      newAuthority,
    },
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "update_authority",
      role,
      currentAuthority: currentAuthorityRaw,
      newAuthority,
    },
    idempotencyKey: null,
  };
}

export const executeUpdateAuthority = async (c: AppContext) => {
  const {
    body: input,
    resolved: {
      tokenId,
      auth,
      tokenService,
      role,
      currentAuthorityRaw,
      walletId,
      mintAddress,
      newAuthority,
    },
  } = getPolicyGateContext<UpdateAuthorityBody, UpdateAuthorityPolicyResolved>(c);

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "update_authority",
    mode: "execute",
    params: input,
  });

  const { transaction: tx, replayed } = await runApprovedWalletOperationEffectTransaction(c, (db) =>
    getTenantTokenService(c, db).createTransaction({
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
    })
  );

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const transaction = await recoverSettledTransactionReplay({
      auditService,
      tokenService,
      transaction: tx,
      action: "update_authority",
    });
    if (
      approvedWalletOperationId(c) &&
      (!transaction.signature ||
        (transaction.status !== "confirmed" && transaction.status !== "finalized"))
    ) {
      // Settlement recovery above may repair a pending row from durable audit
      // evidence. If it cannot, fail closed rather than presenting an
      // unsubmitted authority update as a completed approval.
      await beginApprovedWalletOperationEffect(c);
      throw new AppError(
        "CONFLICT",
        "Approved authority update is incomplete and requires manual reconciliation"
      );
    }
    if (transaction.status === "confirmed") {
      await tokenService.applySettledTokenAuthority(tx.id, tokenId, role, newAuthority);
    }
    return success(c, { transaction });
  }

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    walletId,
    currentAuthority: currentAuthorityRaw,
  });
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const auditIntent = await auditService.beginCritical(c, {
    action: "update_authority",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: { tokenId, role, newAuthority, mode: "execute" },
  });
  let onChainEffectCompleted = false;

  try {
    await beginApprovedWalletOperationEffect(c);
    const result = await mosaic.updateAuthority({
      mint: mintAddress,
      role: mapAuthorityRole(role),
      currentAuthority: signer,
      newAuthority,
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

    await tokenService.applySettledTokenAuthority(tx.id, tokenId, role, newAuthority);

    // This handler now takes its inputs from the policy gate, whose `auth.projectId` is
    // nullable; the emit needs the resolved project scope, as every other one does.
    const { projectId } = requireProjectScope(c);
    emitTokenOperationCompleted(c, {
      organizationId: auth.organizationId,
      projectId,
      tokenId,
      operation: "update_authority",
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
