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
import { getRequestGateContext, type RequestGateExtraction } from "@/middleware/request-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import type { TokenService } from "@/services/token.service";
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
import { toPublicTokenTransaction } from "./public-response";
import {
  persistSettledTransactionThenOutcome,
  recoverSettledTransactionReplay,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;
type MosaicAuthorityRole = Parameters<MosaicService["prepareUpdateAuthority"]>[0]["role"];
type UpdateAuthorityBody = z.output<typeof updateAuthoritySchema>;

interface UpdateAuthorityExecutionResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  role: AuthorityRole;
  currentAuthorityRaw: string;
  custodyWalletId: string;
  mintAddress: ReturnType<typeof assertValidAddress>;
  newAuthority: ReturnType<typeof assertValidAddress> | null;
}

interface UpdateAuthorityReplayResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  role: AuthorityRole;
  custodyWalletId: string;
  newAuthority: ReturnType<typeof assertValidAddress> | null;
  replay: TokenTransaction;
}

type UpdateAuthorityResolved = UpdateAuthorityExecutionResolved | UpdateAuthorityReplayResolved;

export async function admitUpdateAuthorityRuntimeExecution(
  c: AppContext,
  extraction: RequestGateExtraction
): Promise<void> {
  const resolved = extraction.resolved as UpdateAuthorityResolved;
  if ("replay" in resolved) return;
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
): Promise<{ transaction: TokenTransaction } | null> {
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) return null;

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

  await resolveIssuanceWallet({
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

  return { transaction: recovered };
}

async function updateAuthorityReplayResponse(
  c: AppContext,
  resolved: Pick<
    UpdateAuthorityReplayResolved,
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

/** Return a validated persisted authority update before admitting new work. */
export async function findUpdateAuthorityIdempotentKeyReplay(
  c: AppContext,
  extraction: RequestGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const resolved = extraction.resolved as UpdateAuthorityResolved;
  if (!("replay" in resolved)) return null;
  if (resolved.replay.idempotencyKey !== idempotencyKey) {
    throw conflict("Idempotency key already used with different request payload");
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
 * Parse and resolve an authority update into the resources the handler works from.
 *
 * @param c - Request context.
 * @returns The validated body and the resolved resources.
 */
export async function extractUpdateAuthorityRequest(
  c: ValidatedBodyContext<typeof updateAuthoritySchema>
): Promise<RequestGateExtraction> {
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
    return {
      body: input,
      resolved: {
        tokenId,
        auth,
        tokenService,
        role,
        custodyWalletId,
        newAuthority,
        replay: replay.transaction,
      } satisfies UpdateAuthorityReplayResolved,
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

  const { custodyWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    requestedCustodyWalletId: input.signingCustodyWalletId,
    currentAuthority: currentAuthorityRaw,
    requiredWalletPermissions: ["tokens:admin"],
  });
  const mintAddress = assertValidAddress(token.mintAddress, "mintAddress");
  return {
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
  };
}

export const executeUpdateAuthority = async (c: AppContext) => {
  const gate = getRequestGateContext<UpdateAuthorityBody, UpdateAuthorityExecutionResolved>(c);

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

  const { transaction: tx, replayed } = await tokenService.createTransaction({
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
  });

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
