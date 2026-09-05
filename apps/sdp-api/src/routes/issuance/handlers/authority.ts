import type { MosaicService } from "@sdp/issuance/mosaic/service";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { TokenTransaction } from "@sdp/types";
import { AuthorityType } from "@solana-program/token-2022";
import type { Context } from "hono";
import type { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  assertApprovedWalletOperationCustodyWallet,
  beginApprovedWalletOperationEffect,
  runApprovedWalletOperationEffectTransaction,
} from "@/services/policy/approved-operation-replay";
import type { TokenService } from "@/services/token.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { updateAuthoritySchema } from "../schemas";
import {
  type AuthorityRole,
  admitIssuanceRuntimeExecution,
  createResolvedAuthoritySigner,
  resolveAuthoritySigner,
  resolveAuthorityWallet,
  resolveCurrentAuthorityForRole,
  resolveIssuanceWallet,
} from "./authority-resolution";
import { buildIdempotencyMetadata } from "./idempotency";
import { buildIssuancePolicyCandidate } from "./policy";
import { toPublicTokenTransaction } from "./public-response";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicAuthorityRole = Parameters<MosaicService["prepareUpdateAuthority"]>[0]["role"];
type UpdateAuthorityBody = z.output<typeof updateAuthoritySchema>;

interface UpdateAuthorityExecutionPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  role: AuthorityRole;
  currentAuthorityRaw: string;
  custodyWalletId: string;
  mintAddress: ReturnType<typeof assertValidAddress>;
  newAuthority: ReturnType<typeof assertValidAddress> | null;
}

interface UpdateAuthorityReplayPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  role: AuthorityRole;
  custodyWalletId: string;
  newAuthority: ReturnType<typeof assertValidAddress> | null;
  replay: TokenTransaction;
}

type UpdateAuthorityPolicyResolved =
  | UpdateAuthorityExecutionPolicyResolved
  | UpdateAuthorityReplayPolicyResolved;

export async function admitUpdateAuthorityRuntimeExecution(
  c: AppContext,
  extraction: PolicyGateExtraction
): Promise<void> {
  const resolved = extraction.resolved as UpdateAuthorityPolicyResolved;
  if ("replay" in resolved && isSettledAuthorityTransaction(resolved.replay)) return;
  const { auth, tokenService, custodyWalletId } = resolved;
  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId,
    tokenService,
  });
}

function updateAuthorityIdempotencyMetadata(
  idempotencyKey: string | null | undefined,
  tokenId: string,
  input: UpdateAuthorityBody,
  custodyWalletId: string
) {
  return buildIdempotencyMetadata(idempotencyKey, {
    tokenId,
    operation: "update_authority",
    mode: "execute",
    params: { ...input, signingCustodyWalletId: custodyWalletId },
  });
}

function isSettledAuthorityTransaction(transaction: TokenTransaction): boolean {
  return (
    (transaction.status === "confirmed" || transaction.status === "finalized") &&
    transaction.signature !== null
  );
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

async function resolveUpdateAuthorityReplayBeforeLiveChecks(
  c: AppContext,
  input: UpdateAuthorityBody,
  resolved: {
    tokenId: string;
    auth: ApiKeyContext;
    tokenService: TokenService;
  }
): Promise<{ transaction: TokenTransaction; providerWalletId: string } | null> {
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey || isDryRunRequest(c)) return null;

  const transaction = await resolved.tokenService.findTransactionByIdempotency(
    resolved.auth.organizationId,
    idempotencyKey
  );
  if (!transaction) return null;

  const custodyWalletId = input.signingCustodyWalletId ?? transaction.custodyWalletId;
  const fingerprint = custodyWalletId
    ? updateAuthorityIdempotencyMetadata(idempotencyKey, resolved.tokenId, input, custodyWalletId)
        .idempotencyFingerprint
    : undefined;
  if (
    !custodyWalletId ||
    transaction.tokenId !== resolved.tokenId ||
    transaction.type !== "update_authority" ||
    transaction.custodyWalletId !== custodyWalletId ||
    transaction.idempotencyFingerprint !== fingerprint
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }

  const wallet = await resolveIssuanceWallet({
    env: c.env,
    auth: resolved.auth,
    custodyWalletId,
    requiredWalletPermissions: ["tokens:admin"],
  });
  const recovered = await recoverSettledTransactionReplay({
    auditService: new AuditService(getDb(c.env)),
    tokenService: resolved.tokenService,
    transaction,
    action: "update_authority",
  });

  return { transaction: recovered, providerWalletId: wallet.providerWalletId };
}

async function updateAuthorityReplayResponse(
  c: AppContext,
  resolved: Pick<
    UpdateAuthorityReplayPolicyResolved,
    "tokenId" | "tokenService" | "role" | "newAuthority" | "replay"
  >
) {
  if (resolved.replay.status === "confirmed") {
    await resolved.tokenService.applySettledTokenAuthority(
      resolved.replay.id,
      resolved.tokenId,
      resolved.role,
      resolved.newAuthority
    );
  }
  return success(c, { transaction: toPublicTokenTransaction(resolved.replay) });
}

/** Return a validated persisted authority update before admission or policy writes. */
export async function findUpdateAuthorityIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const resolved = extraction.resolved as UpdateAuthorityPolicyResolved;
  if (!("replay" in resolved)) return null;
  if (resolved.replay.idempotencyKey !== idempotencyKey) {
    throw conflict("Idempotency key already used with different request payload");
  }
  await assertApprovedWalletOperationCustodyWallet(c, resolved.custodyWalletId);
  if (approvedWalletOperationId(c) && !isSettledAuthorityTransaction(resolved.replay)) {
    return null;
  }
  return updateAuthorityReplayResponse(c, resolved);
}

export const prepareUpdateAuthority = async (
  c: ValidatedBodyContext<typeof updateAuthoritySchema>
) => {
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

  if (!token.mintAddress || token.status === "pending") {
    throw new AppError("TOKEN_NOT_DEPLOYED", "Token has not been deployed to Solana");
  }

  const role = body.authority.role;
  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    role,
    body.authority.currentAuthority
  );

  if (!currentAuthorityRaw) {
    throw badRequest("Current authority is not available for this token");
  }

  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  const currentAuthority = assertValidAddress(currentAuthorityRaw, "currentAuthority");
  const newAuthority = body.authority.newAuthority
    ? assertValidAddress(body.authority.newAuthority, "newAuthority")
    : null;

  const { custodyWalletId, signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    currentAuthority: currentAuthorityRaw,
    requiredWalletPermissions: ["tokens:admin"],
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
  if (body.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
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
    transaction: toPublicTokenTransaction(tx),
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
  c: ValidatedBodyContext<typeof updateAuthoritySchema>
): Promise<PolicyGateExtraction> {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const input = c.req.valid("json");
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
  const newAuthority = input.authority.newAuthority
    ? assertValidAddress(input.authority.newAuthority, "newAuthority")
    : null;
  const replay = await resolveUpdateAuthorityReplayBeforeLiveChecks(c, input, {
    tokenId,
    auth,
    tokenService,
  });
  if (replay) {
    const custodyWalletId = replay.transaction.custodyWalletId;
    if (!custodyWalletId) {
      throw conflict("Idempotent issuance transaction has no exact wallet identity");
    }
    const currentAuthorityRaw =
      typeof replay.transaction.params.currentAuthority === "string"
        ? replay.transaction.params.currentAuthority
        : null;
    return {
      candidate: buildIssuancePolicyCandidate({
        auth,
        token,
        custodyWalletId,
        walletId: replay.providerWalletId,
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
        custodyWalletId,
        newAuthority,
        replay: replay.transaction,
      } satisfies UpdateAuthorityReplayPolicyResolved,
      rawPayload: {
        tokenId: token.id,
        mintAddress: token.mintAddress,
        action: "update_authority",
        role,
        currentAuthority: currentAuthorityRaw,
        newAuthority,
      },
      executionRequestBody: {
        ...input,
        signingCustodyWalletId: custodyWalletId,
      },
      idempotencyKey: null,
    };
  }

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

  const { custodyWalletId, providerWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    requestedCustodyWalletId: input.signingCustodyWalletId,
    currentAuthority: currentAuthorityRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  return {
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId,
      walletId: providerWalletId,
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
      custodyWalletId,
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
    executionRequestBody: {
      ...input,
      signingCustodyWalletId: custodyWalletId,
    },
    idempotencyKey: null,
  };
}

export const executeUpdateAuthority = async (c: AppContext) => {
  const gate = getPolicyGateContext<UpdateAuthorityBody, UpdateAuthorityPolicyResolved>(c);
  if ("replay" in gate.resolved) {
    await assertApprovedWalletOperationCustodyWallet(c, gate.resolved.custodyWalletId);
    if (approvedWalletOperationId(c) && !isSettledAuthorityTransaction(gate.resolved.replay)) {
      await beginApprovedWalletOperationEffect(c);
      throw conflict("Approved authority update is incomplete and requires manual reconciliation");
    }
    return updateAuthorityReplayResponse(c, gate.resolved);
  }

  const {
    body: input,
    resolved: {
      tokenId,
      auth,
      tokenService,
      role,
      currentAuthorityRaw,
      custodyWalletId,
      mintAddress,
      newAuthority,
    },
  } = gate;

  await assertApprovedWalletOperationCustodyWallet(c, custodyWalletId);

  const signer = await createResolvedAuthoritySigner({
    env: c.env,
    auth,
    custodyWalletId,
    currentAuthority: currentAuthorityRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });

  const idempotencyMetadata = updateAuthorityIdempotencyMetadata(
    c.req.header("Idempotency-Key"),
    tokenId,
    input,
    custodyWalletId
  );

  const { transaction: tx, replayed } = await runApprovedWalletOperationEffectTransaction(c, (db) =>
    getTenantTokenService(c, db).createTransaction({
      tokenId,
      organizationId: auth.organizationId,
      custodyWalletId,
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

  if (tx.custodyWalletId !== custodyWalletId) {
    throw new AppError("FORBIDDEN", "Issuance transaction does not match wallet identity");
  }

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
    return updateAuthorityReplayResponse(c, {
      tokenId,
      tokenService,
      role,
      newAuthority,
      replay: transaction,
    });
  }

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
