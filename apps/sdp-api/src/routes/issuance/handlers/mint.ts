import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { TokenTransaction } from "@sdp/types";
import type { Context } from "hono";
import type { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { isDryRunRequest } from "@/middleware/dry-run";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  assertApprovedWalletOperationCustodyWallet,
  beginApprovedWalletOperationEffect,
  reserveMintSupplyAtApprovedEffectBoundary,
} from "@/services/policy/approved-operation-replay";
import type { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import type { mintSchema } from "../schemas";
import {
  assertDestinationAllowedByControlList,
  getOnChainAllowlistMutationForMint,
} from "./access-control";
import {
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
  persistSettledTransaction,
  persistSettledTransactionThenOutcome,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;

type MintBody = z.output<typeof mintSchema>;

type MintOperationAmount = ReturnType<typeof resolveMintOperationAmount>;

interface MintExecutionPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  mintAddress: ReturnType<typeof assertValidAddress>;
  destination: ReturnType<typeof assertValidAddress>;
  mosaicAmount: MintOperationAmount["mosaicAmount"];
  amountBaseUnits: MintOperationAmount["amountBaseUnits"];
  ablListAddress: string | null;
  currentAuthority: string;
  custodyWalletId: string;
}

interface MintReplayPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  custodyWalletId: string;
  replay: TokenTransaction;
}

type MintPolicyResolved = MintExecutionPolicyResolved | MintReplayPolicyResolved;

export async function admitMintRuntimeExecution(
  c: AppContext,
  extraction: PolicyGateExtraction
): Promise<void> {
  const resolved = extraction.resolved as MintPolicyResolved;
  if ("replay" in resolved && isSettledIssuanceTransaction(resolved.replay)) return;
  const { auth, tokenService, custodyWalletId } = resolved;
  await admitIssuanceRuntimeExecution({
    env: c.env,
    auth,
    custodyWalletId,
    tokenService,
  });
}

function mintIdempotencyMetadata(
  idempotencyKey: string | null | undefined,
  tokenId: string,
  input: MintBody,
  custodyWalletId: string
) {
  return buildIdempotencyMetadata(idempotencyKey, {
    tokenId,
    operation: "mint",
    mode: "execute",
    params: { ...input, signingCustodyWalletId: custodyWalletId },
  });
}

function isSettledIssuanceTransaction(transaction: TokenTransaction): boolean {
  return (
    (transaction.status === "confirmed" || transaction.status === "finalized") &&
    transaction.signature !== null
  );
}

interface SettledMintEvidence {
  signature: string;
  slot: number;
  tokenAccount: string;
}

function parseSettledMintEvidence(metadata: Record<string, unknown>): SettledMintEvidence | null {
  const slot =
    typeof metadata.slot === "string" && /^\d+$/.test(metadata.slot)
      ? Number(metadata.slot)
      : metadata.slot;
  if (
    typeof metadata.signature !== "string" ||
    metadata.signature.length === 0 ||
    !Number.isSafeInteger(slot) ||
    Number(slot) < 0 ||
    typeof metadata.tokenAccount !== "string" ||
    metadata.tokenAccount.length === 0
  ) {
    return null;
  }
  return {
    signature: metadata.signature,
    slot: Number(slot),
    tokenAccount: metadata.tokenAccount,
  };
}

async function persistSettledMintTransaction(
  tokenService: TokenService,
  transaction: TokenTransaction,
  evidence: SettledMintEvidence
): Promise<TokenTransaction> {
  return persistSettledTransaction(tokenService, transaction, evidence, {
    tokenAccount: evidence.tokenAccount,
  });
}

async function recoverSettledMintReplay(
  auditService: AuditService,
  tokenService: TokenService,
  transaction: TokenTransaction
): Promise<TokenTransaction> {
  if (transaction.status !== "pending") return transaction;
  const journaledEvidence = parseSettledMintEvidence({
    ...transaction.params,
    signature: transaction.signature,
    slot: transaction.slot,
  });
  if (journaledEvidence) {
    return persistSettledMintTransaction(tokenService, transaction, journaledEvidence);
  }
  const outcome = await auditService.findCriticalOutcome({
    organizationId: transaction.organizationId,
    action: "mint",
    resourceType: "token_transaction",
    resourceId: transaction.id,
  });
  if (outcome?.status !== "success") return transaction;
  const evidence = parseSettledMintEvidence(outcome.metadata);
  return evidence
    ? persistSettledMintTransaction(tokenService, transaction, evidence)
    : transaction;
}

async function resolveMintReplayBeforeLiveChecks(
  c: AppContext,
  input: MintBody,
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
    ? mintIdempotencyMetadata(idempotencyKey, resolved.tokenId, input, custodyWalletId)
        .idempotencyFingerprint
    : undefined;
  if (
    !custodyWalletId ||
    transaction.tokenId !== resolved.tokenId ||
    transaction.type !== "mint" ||
    transaction.custodyWalletId !== custodyWalletId ||
    transaction.idempotencyFingerprint !== fingerprint
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }

  const wallet = await resolveIssuanceWallet({
    env: c.env,
    auth: resolved.auth,
    custodyWalletId,
    requiredWalletPermissions: ["tokens:write"],
  });
  const recovered = await recoverSettledMintReplay(
    new AuditService(getDb(c.env)),
    resolved.tokenService,
    transaction
  );

  return { transaction: recovered, providerWalletId: wallet.providerWalletId };
}

function mintReplayResponse(c: AppContext, input: MintBody, transaction: TokenTransaction) {
  const tokenAccount =
    typeof transaction.params.tokenAccount === "string"
      ? transaction.params.tokenAccount
      : input.mint.destination;
  return success(c, {
    transaction: toPublicTokenTransaction(transaction),
    tokenAccount,
  });
}

/** Return a validated persisted mint before admission or policy writes. */
export async function findMintIdempotentKeyReplay(
  c: AppContext,
  extraction: PolicyGateExtraction,
  idempotencyKey: string
): Promise<Response | null> {
  const resolved = extraction.resolved as MintPolicyResolved;
  if (!("replay" in resolved)) return null;
  if (resolved.replay.idempotencyKey !== idempotencyKey) {
    throw conflict("Idempotency key already used with different request payload");
  }
  await assertApprovedWalletOperationCustodyWallet(c, resolved.custodyWalletId);
  if (approvedWalletOperationId(c) && !isSettledIssuanceTransaction(resolved.replay)) {
    return null;
  }
  return mintReplayResponse(c, extraction.body as MintBody, resolved.replay);
}

type AllowlistInsertArgs = {
  tokenId: string;
  address: string;
  addedBy: string;
};

/**
 * Idempotently ensure a DB allowlist row exists for the destination.
 *
 * Used both when the wallet is already on-chain (just need the mirror) and
 * after a successful on-chain add when we didn't own the original insert
 * (closes the race where a parallel owner hard-deleted its row between our
 * insert attempt and now). Swallows ADDRESS_ALREADY_ALLOWLISTED — anything
 * else (including DESTINATION_REVOKED from a mid-flight operator revoke)
 * bubbles up.
 */
async function ensureDbAllowlistRow(
  tokenService: TokenService,
  args: AllowlistInsertArgs
): Promise<void> {
  try {
    await tokenService.addAllowlistEntryStrict(args);
  } catch (error) {
    if (!(error instanceof Error && error.message === "ADDRESS_ALREADY_ALLOWLISTED")) {
      throw error;
    }
  }
}

/**
 * Hard-delete a DB row we just created in this call after the on-chain add
 * fails and on-chain membership is not confirmed. Hard-delete (not revoke)
 * so a transient on-chain failure doesn't leave behind a `revoked` row that
 * would trip the operator-revoked guard on every retry. Always throws —
 * either the wrapped INTERNAL_ERROR on rollback failure or the original
 * add-error otherwise.
 */
async function rollbackCreatedAllowlistEntry(
  tokenService: TokenService,
  entryId: string,
  originalError: unknown
): Promise<never> {
  try {
    await tokenService.deleteAllowlistEntry(entryId);
  } catch (rollbackError) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Failed to roll back control-list entry after mint sync error",
      {
        originalError: originalError instanceof Error ? originalError.message : "Unknown add error",
        restoreError:
          rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error",
      }
    );
  }
  throw originalError;
}

/**
 * Sync a destination wallet to the on-chain ABL list.
 *
 * Uses the on-chain ABL list as the source of truth, since the DB mirror can
 * lag behind a pending on-chain tx (concurrent requests can see a fresh DB
 * row before the matching on-chain tx confirms). Steps:
 *
 *  1. Check if the wallet is already on-chain. If yes, just ensure the DB
 *     mirror exists (idempotent) and return — no new on-chain write needed.
 *  2. Otherwise, run a DB-first / on-chain-second sync: insert the DB row,
 *     then write on-chain. If the on-chain write fails and we created the DB
 *     row, roll it back so the two layers stay in sync.
 *
 * Returns `true` when the destination was absent from the on-chain list at the
 * start of the call and this call drove it onto the list with the DB mirror
 * consistent — including the TOCTOU/transient-error recovery where the
 * on-chain write reports an error but membership is confirmed afterward (the DB
 * row already exists at that point, so both layers agree). Returns `false` only
 * when the destination was already on the list at the start of the call.
 * Throws when the on-chain write fails and membership cannot be confirmed.
 */
async function syncDestinationToOnChainAllowlist(opts: {
  c: AppContext;
  tokenService: TokenService;
  mosaic: ReturnType<typeof createIssuanceMosaicService>;
  tokenId: string;
  ablListAddress: string;
  destinationRaw: string;
  destination: ReturnType<typeof assertValidAddress>;
  addedBy: string;
}): Promise<boolean> {
  const listAddress = assertValidAddress(opts.ablListAddress, "ablListAddress");
  const dbArgs: AllowlistInsertArgs = {
    tokenId: opts.tokenId,
    address: opts.destinationRaw,
    addedBy: opts.addedBy,
  };

  // Fast-path bail when the destination is already in the `revoked` state —
  // saves one RPC (`isWalletOnList`) on the common case. Race-safety against a
  // revoke that lands AFTER this check is delegated to `addAllowlistEntryStrict`
  // below, which refuses to reactivate any existing row (active or revoked) and
  // throws `DESTINATION_REVOKED` if the row is revoked at insert time.
  const existingStatus = await opts.tokenService.getAllowlistEntryStatusByAddress(
    opts.tokenId,
    opts.destinationRaw
  );
  if (existingStatus === "revoked") {
    throw new AppError("DESTINATION_REVOKED");
  }

  if (await opts.mosaic.isWalletOnList(listAddress, opts.destination)) {
    await ensureDbAllowlistRow(opts.tokenService, dbArgs);
    return false;
  }

  let createdEntryId: string | null = null;
  try {
    const entry = await opts.tokenService.addAllowlistEntryStrict(dbArgs);
    createdEntryId = entry.id;
  } catch (error) {
    if (!(error instanceof Error && error.message === "ADDRESS_ALREADY_ALLOWLISTED")) {
      throw error;
    }
    // Race: a parallel request inserted the DB row between our on-chain
    // check above and this insert. We already verified on-chain was empty,
    // so still attempt the on-chain add — but don't roll back the DB row
    // since we don't own it.
  }

  try {
    await beginApprovedWalletOperationEffect(opts.c);
    await opts.mosaic.addToList({
      list: listAddress,
      wallet: opts.destination,
    });
  } catch (error) {
    // TOCTOU: a parallel request may have added the wallet on-chain between
    // our initial isWalletOnList check and this add (or the add raced a
    // transient RPC/confirmation error but the wallet is in fact on-chain).
    // If on-chain membership now holds, both layers are consistent — fall
    // through to the DB re-assert below.
    if (await opts.mosaic.isWalletOnList(listAddress, opts.destination)) {
      // fall through
    } else if (createdEntryId) {
      await rollbackCreatedAllowlistEntry(opts.tokenService, createdEntryId, error);
    } else {
      throw error;
    }
  }

  // Re-assert the DB row when we didn't own the original insert. Closes a
  // race: a parallel request that did own the row may have hard-deleted it
  // during its own rollback after our `addAllowlistEntryStrict` returned
  // ADDRESS_ALREADY_ALLOWLISTED. Without this re-assert, we'd end with the
  // wallet on-chain but no DB mirror.
  if (createdEntryId === null) {
    await ensureDbAllowlistRow(opts.tokenService, dbArgs);
  }

  return true;
}

export const prepareMint = async (c: ValidatedBodyContext<typeof mintSchema>) => {
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

  const {
    mintAddress: mintAddressRaw,
    mosaicAmount,
    amountBaseUnits,
  } = resolveMintOperationAmount(token, body.mint.amount);

  const ablListAddress = getOnChainAllowlistMutationForMint(token);
  if (!ablListAddress) {
    const isOnControlList = await tokenService.isAddressAllowed(tokenId, body.mint.destination);
    assertDestinationAllowedByControlList({
      token,
      destination: body.mint.destination,
      isOnControlList,
    });
  }

  const currentAuthority = await resolveCurrentAuthorityForRole(c.env, tokenService, token, "mint");
  if (!currentAuthority) {
    throw badRequest("Current mint authority is not available for this token");
  }
  const mintAuthority = assertValidAddress(currentAuthority, "mintAuthority");
  const { custodyWalletId, signer } = await resolveAuthoritySigner({
    env: c.env,
    auth,
    requestedCustodyWalletId: body.signingCustodyWalletId,
    currentAuthority: mintAuthority,
    requiredWalletPermissions: ["tokens:write"],
  });
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(body.mint.destination, "destination");

  // Build unsigned transaction using Mosaic
  // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

  // Preparation must not mutate on-chain compliance state. A destination that
  // is not already on the ABL can only be added by the execute route after its
  // wallet-operation policy and approval gate have run.
  if (ablListAddress) {
    const existingStatus = await tokenService.getAllowlistEntryStatusByAddress(
      tokenId,
      body.mint.destination
    );
    if (existingStatus === "revoked") {
      throw new AppError("DESTINATION_REVOKED");
    }
    const listAddress = assertValidAddress(ablListAddress, "ablListAddress");
    if (!(await mosaic.isWalletOnList(listAddress, destination))) {
      throw new AppError("NOT_ON_TOKEN_ALLOWLIST");
    }
  }

  const prepared = await mosaic.prepareMintTo({
    mint: mintAddress,
    destination,
    amount: mosaicAmount,
    mintAuthority,
    feePayer: signer.address,
  });

  let simulation: unknown;
  if (body.options?.simulate) {
    const rpc = createRpc(c.env);
    const txBytes = Buffer.from(prepared.serializedTx, "base64");
    simulation = await simulateTransaction(rpc, txBytes);
  }

  // The row goes in before the reservation and without the serialized transaction.
  // Before: the row is what tells `POST /supply/refresh` a mint is unsettled, so a
  // reservation without one sits exposed to a concurrent refresh erasing it.
  // Without: a serialized transaction in the row is readable through the
  // transactions API and, in the wallet-authority flow, submittable by whoever
  // reads it — it may not exist anywhere durable until the cap has admitted it.
  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
    type: "mint",
    params: {
      destination: body.mint.destination,
      amount: body.mint.amount,
      memo: body.mint.memo,
    },
    initiatedByKeyId: auth.id,
  });

  // Counted against the cap before the transaction leaves SDP, exactly as an
  // executed mint is counted before submission — a prepared transaction is a mint
  // the client can settle at any point until its blockhash expires, so handing it
  // out IS the point of no return. The pre-flight check above read a cached total
  // in this process, which a concurrent mint or cap change can invalidate; this
  // conditional UPDATE contends for the token row itself, so it either sees the
  // new cap and refuses, or lands first and the cap change fails its own
  // supply-unchanged guard. If the client never submits, the reservation comes
  // back through `POST /supply/refresh` once the transaction can no longer land.
  const reservedSupply = await tokenService.reserveMintSupply(tokenId, amountBaseUnits.toString());
  if (reservedSupply === null) {
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: "Mint amount would exceed maximum supply",
    });
    throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
  }

  const preparedTx = await tokenService.updateTransaction(tx.id, {
    serializedTx: prepared.serializedTx,
  });

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "mint",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      destination: body.mint.destination,
      amount: body.mint.amount,
      mode: "prepare",
      addedToAllowlist: false,
    },
  });

  return success(c, {
    transaction: toPublicTokenTransaction(preparedTx),
    preparedTransaction: {
      serialized: prepared.serializedTx,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
    },
    tokenAccount: prepared.tokenAccount,
    simulation,
  });
};

async function recordPreSubmissionMintFailure(options: {
  c: AppContext;
  auditService: AuditService;
  auditIntent: AuditIntent;
  tokenService: TokenService;
  transactionId: string;
  error: unknown;
}): Promise<void> {
  const errorMessage = options.error instanceof Error ? options.error.message : "Unknown error";
  await options.auditService.completeCritical(options.c, options.auditIntent, {
    status: "failure",
    metadata: { error: errorMessage },
  });

  // Nothing reached the mint submission boundary, so release the idempotency
  // slot. Retaining a failed row here would make every retry replay that stale
  // failure instead of re-evaluating the wallet and allowlist state.
  const removedPreEffectTransaction = await options.tokenService.deleteUnsubmittedTransaction(
    options.transactionId
  );
  if (!removedPreEffectTransaction) {
    await options.tokenService.updateTransaction(options.transactionId, {
      status: "failed",
      error: errorMessage,
    });
  }
}

/**
 * Parse and resolve an execute-mint request into its wallet-operation policy candidate.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resources, and raw payload.
 */
export async function extractMintPolicyCandidate(
  c: ValidatedBodyContext<typeof mintSchema>
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

  const replay = await resolveMintReplayBeforeLiveChecks(c, input, {
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
      candidate: buildIssuancePolicyCandidate({
        auth,
        token,
        custodyWalletId,
        walletId: replay.providerWalletId,
        operationType: "issuance_mint_execute",
        amount: input.mint.amount,
        destination: input.mint.destination,
      }),
      legs: [],
      body: input,
      resolved: {
        tokenId,
        auth,
        tokenService,
        custodyWalletId,
        replay: replay.transaction,
      } satisfies MintReplayPolicyResolved,
      rawPayload: {
        tokenId: token.id,
        mintAddress: token.mintAddress,
        action: "mint",
        destination: input.mint.destination,
        amount: input.mint.amount,
        memo: input.mint.memo === undefined ? null : input.mint.memo,
      },
      executionRequestBody: {
        ...input,
        signingCustodyWalletId: custodyWalletId,
      },
      idempotencyKey: null,
    };
  }

  const {
    mintAddress: mintAddressRaw,
    mosaicAmount,
    amountBaseUnits,
  } = resolveMintOperationAmount(token, input.mint.amount);
  const ablListAddress = getOnChainAllowlistMutationForMint(token);
  if (!ablListAddress) {
    const isOnControlList = await tokenService.isAddressAllowed(tokenId, input.mint.destination);
    assertDestinationAllowedByControlList({
      token,
      destination: input.mint.destination,
      isOnControlList,
    });
  }

  const currentAuthorityRaw = await resolveCurrentAuthorityForRole(
    c.env,
    tokenService,
    token,
    "mint"
  );
  if (!currentAuthorityRaw) {
    throw badRequest("Current mint authority is not available for this token");
  }
  const currentAuthority = assertValidAddress(currentAuthorityRaw, "mintAuthority");
  const { custodyWalletId, providerWalletId } = await resolveAuthorityWallet({
    env: c.env,
    auth,
    requestedCustodyWalletId: input.signingCustodyWalletId,
    currentAuthority,
    requiredWalletPermissions: ["tokens:write"],
  });
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(input.mint.destination, "destination");

  return {
    candidate: buildIssuancePolicyCandidate({
      auth,
      token,
      custodyWalletId,
      walletId: providerWalletId,
      operationType: "issuance_mint_execute",
      amount: input.mint.amount,
      destination: input.mint.destination,
    }),
    legs: [],
    body: input,
    resolved: {
      tokenId,
      auth,
      tokenService,
      mintAddress,
      destination,
      mosaicAmount,
      amountBaseUnits,
      ablListAddress,
      currentAuthority,
      custodyWalletId,
    },
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "mint",
      destination: input.mint.destination,
      amount: input.mint.amount,
      memo: input.mint.memo === undefined ? null : input.mint.memo,
    },
    executionRequestBody: {
      ...input,
      signingCustodyWalletId: custodyWalletId,
    },
    idempotencyKey: null,
  };
}

export const executeMint = async (c: AppContext) => {
  const gate = getPolicyGateContext<MintBody, MintPolicyResolved>(c);
  if ("replay" in gate.resolved) {
    await assertApprovedWalletOperationCustodyWallet(c, gate.resolved.custodyWalletId);
    if (approvedWalletOperationId(c) && !isSettledIssuanceTransaction(gate.resolved.replay)) {
      await beginApprovedWalletOperationEffect(c);
      throw conflict("Approved mint execution is incomplete and requires manual reconciliation");
    }
    return mintReplayResponse(c, gate.body, gate.resolved.replay);
  }

  const {
    body: input,
    resolved: {
      tokenId,
      auth,
      tokenService,
      mintAddress,
      destination,
      mosaicAmount,
      amountBaseUnits,
      ablListAddress,
      currentAuthority,
      custodyWalletId,
    },
  } = gate;

  await assertApprovedWalletOperationCustodyWallet(c, custodyWalletId);

  const idempotencyMetadata = mintIdempotencyMetadata(
    c.req.header("Idempotency-Key"),
    tokenId,
    input,
    custodyWalletId
  );

  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    custodyWalletId,
    type: "mint",
    params: {
      destination: input.mint.destination,
      amount: input.mint.amount,
      memo: input.mint.memo,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (tx.custodyWalletId !== custodyWalletId) {
    throw new AppError("FORBIDDEN", "Issuance transaction does not match wallet identity");
  }

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const replayedTransaction = await recoverSettledMintReplay(auditService, tokenService, tx);
    if (approvedWalletOperationId(c) && !isSettledIssuanceTransaction(replayedTransaction)) {
      await beginApprovedWalletOperationEffect(c);
      throw conflict("Approved mint execution is incomplete and requires manual reconciliation");
    }
    return mintReplayResponse(c, input, replayedTransaction);
  }

  const auditIntent = await auditService.beginCritical(c, {
    action: "mint",
    resourceType: "token_transaction",
    resourceId: tx.id,
    metadata: {
      tokenId,
      destination: input.mint.destination,
      amount: input.mint.amount,
      mode: "execute",
    },
  });

  // Counted against the cap in the last moment before the transaction is submitted,
  // and only then. The check above ran against a cached total in this process, which
  // two concurrent mints — or a concurrent cap change — can both pass; this is a
  // conditional UPDATE on the token row, so the database serializes it and the second
  // caller sees the first's result. Refusing here aborts the submission, so a cap
  // that has no room does not spend a transaction.
  //
  // Placement is the point: building the transaction, resolving the token account and
  // signing can all fail without anything reaching the chain, and holding a
  // reservation through those failures would retire headroom no token ever used, down
  // to false MAX_SUPPLY_EXCEEDED on the next legitimate mint. Past this line no
  // failure proves that much, which is why the reservation then stands.
  let reservedSupply: string | null = null;
  let addedToAllowlist = false;
  try {
    const signer = await createResolvedAuthoritySigner({
      env: c.env,
      auth,
      custodyWalletId: tx.custodyWalletId,
      currentAuthority,
      requiredWalletPermissions: ["tokens:write"],
    });
    const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
    addedToAllowlist = ablListAddress
      ? await syncDestinationToOnChainAllowlist({
          c,
          tokenService,
          mosaic,
          tokenId,
          ablListAddress,
          destinationRaw: input.mint.destination,
          destination,
          addedBy: auth.id,
        })
      : false;

    const result = await mosaic.mintTo(
      {
        mint: mintAddress,
        destination,
        amount: mosaicAmount,
        mintAuthority: signer.address,
        feePayer: signer.address,
      },
      async () => {
        reservedSupply = await reserveMintSupplyAtApprovedEffectBoundary(
          c,
          tokenId,
          amountBaseUnits.toString()
        );
      }
    );

    const settledTokenAccount =
      result.tokenAccount === undefined ? input.mint.destination : result.tokenAccount;
    const settledEvidence: SettledMintEvidence = {
      signature: result.signature,
      slot: Number(result.slot),
      tokenAccount: settledTokenAccount,
    };
    const settledTransaction = await persistSettledTransactionThenOutcome({
      tokenService,
      transaction: tx,
      evidence: settledEvidence,
      params: { tokenAccount: settledTokenAccount },
      persistOutcome: () =>
        auditService.completeCritical(c, auditIntent, {
          metadata: {
            signature: result.signature,
            slot: result.slot.toString(),
            tokenAccount: settledTokenAccount,
            addedToAllowlist,
          },
        }),
    });

    // This handler now takes its inputs from the policy gate, whose `auth.projectId` is
    // nullable; the emit needs the resolved project scope, as every other one does.
    const { projectId } = requireProjectScope(c);
    emitTokenOperationCompleted(c, {
      organizationId: auth.organizationId,
      projectId,
      tokenId,
      operation: "mint",
      signature: result.signature,
      slot: result.slot.toString(),
    });

    return success(c, {
      transaction: toPublicTokenTransaction(settledTransaction),
      tokenAccount: settledTokenAccount,
    });
  } catch (error) {
    if (reservedSupply === null) {
      await recordPreSubmissionMintFailure({
        c,
        auditService,
        auditIntent,
        tokenService,
        transactionId: tx.id,
        error,
      });
    }

    // A reservation exists only if the gate ran, which means the transaction was
    // submitted — and then it stands. Reaching here does not mean nothing landed: a
    // timeout during confirmation leaves a transaction the cluster may still accept,
    // and the audit write and status write above run *after* the mint has settled.
    // Handing the headroom back on any of those would let a second mint reserve supply
    // the first already minted, and both would be above the cap with no way to undo
    // it. `POST /supply/refresh` reconciles from the mint account once the transaction
    // can no longer land — which is also what returns the headroom if it never did.
    if (reservedSupply !== null) {
      getLogger().warn(
        {
          event: "mint_supply_reservation_retained",
          tokenId,
          transactionId: tx.id,
          reservedBaseUnits: amountBaseUnits.toString(),
          recordedSupplyBaseUnits: reservedSupply,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Mint failed after it was submitted and its supply reserved; the reservation is kept because the transaction may still land. Refresh the token's supply to reconcile."
      );
    }
    throw error;
  }
};
