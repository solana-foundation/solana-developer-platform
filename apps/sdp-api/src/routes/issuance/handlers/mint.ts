import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { TokenTransaction } from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import { getLogger } from "@/runtime/logger";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import {
  approvedWalletOperationId,
  beginApprovedWalletOperationEffect,
  reserveMintSupplyAtApprovedEffectBoundary,
} from "@/services/policy/approved-operation-replay";
import { resolvePolicyCustodyWallet } from "@/services/policy/enforcement.service";
import { createOrgSigner } from "@/services/solana";
import type { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
import { emitTokenOperationCompleted } from "@/services/workflows/token-events";
import type { Env } from "@/types/env";
import {
  createIssuanceMosaicService,
  getTenantTokenService,
  requireProjectScope,
} from "../helpers";
import { mintSchema } from "../schemas";
import {
  assertDestinationAllowedByControlList,
  getOnChainAllowlistMutationForMint,
} from "./access-control";
import { buildIdempotencyMetadata } from "./idempotency";
import { buildIssuancePolicyCandidate } from "./policy";
import {
  persistSettledTransaction,
  persistSettledTransactionThenOutcome,
} from "./settled-transaction";

type AppContext = Context<{ Bindings: Env }>;

type MintBody = z.output<typeof mintSchema>;

type MintOperationAmount = ReturnType<typeof resolveMintOperationAmount>;

interface MintPolicyResolved {
  tokenId: string;
  auth: ApiKeyContext;
  tokenService: TokenService;
  mintAddress: ReturnType<typeof assertValidAddress>;
  destination: ReturnType<typeof assertValidAddress>;
  mosaicAmount: MintOperationAmount["mosaicAmount"];
  amountBaseUnits: MintOperationAmount["amountBaseUnits"];
  ablListAddress: string | null;
  signingWalletId: string | null;
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

export const prepareMint = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);

  const body = await c.req.json();
  const parsed = mintSchema.safeParse(body);

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

  const {
    mintAddress: mintAddressRaw,
    mosaicAmount,
    amountBaseUnits,
  } = resolveMintOperationAmount(token, parsed.data.mint.amount);

  const ablListAddress = getOnChainAllowlistMutationForMint(token);
  if (!ablListAddress) {
    const isOnControlList = await tokenService.isAddressAllowed(
      tokenId,
      parsed.data.mint.destination
    );
    assertDestinationAllowedByControlList({
      token,
      destination: parsed.data.mint.destination,
      isOnControlList,
    });
  }

  const signingWalletId = resolveApiKeySigningWalletId(
    auth,
    parsed.data.signingWalletId ?? token.signingWalletId,
    ["tokens:write"]
  );

  // Get mint authority (custody signer via 3-tier resolution)
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mintAuthority = assertValidAddress(token.mintAuthority ?? "", "mintAuthority");
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  // Build unsigned transaction using Mosaic
  // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");

  // Preparation must not mutate on-chain compliance state. A destination that
  // is not already on the ABL can only be added by the execute route after its
  // wallet-operation policy and approval gate have run.
  if (ablListAddress) {
    const existingStatus = await tokenService.getAllowlistEntryStatusByAddress(
      tokenId,
      parsed.data.mint.destination
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
  if (parsed.data.options?.simulate) {
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
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
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
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      mode: "prepare",
      addedToAllowlist: false,
    },
  });

  return success(c, {
    transaction: preparedTx,
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

  // A failed approved replay that never reserved supply did not cross the
  // mint submission boundary. Release its durable idempotency key so a
  // recovered execution can retry instead of replaying a stale failure.
  const removedPreEffectReplay = approvedWalletOperationId(options.c)
    ? await options.tokenService.deleteUnsubmittedTransaction(options.transactionId)
    : false;
  if (!removedPreEffectReplay) {
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
 * @returns The candidate or ungoverned marker, validated body, resources, and raw payload.
 */
export async function extractMintPolicyCandidate(c: AppContext): Promise<PolicyGateExtraction> {
  const { tokenId } = c.req.param();
  const { auth, projectId, orgId } = requireProjectScope(c);
  const parsed = mintSchema.safeParse(await c.req.json());
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

  const requestedSigningWalletId =
    input.signingWalletId === undefined || input.signingWalletId === null
      ? token.signingWalletId
      : input.signingWalletId;
  const signingWalletId = resolveApiKeySigningWalletId(auth, requestedSigningWalletId, [
    "tokens:write",
  ]);
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(input.mint.destination, "destination");
  const policyWallet =
    signingWalletId === null
      ? null
      : await resolvePolicyCustodyWallet(c.env, auth, signingWalletId);

  return {
    candidate:
      signingWalletId === null
        ? null
        : buildIssuancePolicyCandidate({
            auth,
            token,
            custodyWalletId: policyWallet === null ? null : policyWallet.id,
            walletId: signingWalletId,
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
      signingWalletId,
    },
    rawPayload: {
      tokenId: token.id,
      mintAddress: token.mintAddress,
      action: "mint",
      destination: input.mint.destination,
      amount: input.mint.amount,
      memo: input.mint.memo === undefined ? null : input.mint.memo,
    },
    idempotencyKey: null,
  };
}

export const executeMint = async (c: AppContext) => {
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
      signingWalletId,
    },
  } = getPolicyGateContext<MintBody, MintPolicyResolved, WalletOperationPolicyEnforcement | null>(
    c
  );

  // Resolve signer + sync the destination on-chain BEFORE createTransaction.
  // If sync (or its inner revoke check) throws inside the try block below,
  // the idempotency-keyed tx record gets stored as "failed" and every retry
  // under that key replays the stale failed row (200 with status="failed")
  // instead of re-evaluating after the operator re-adds the address. By
  // running sync first, a DESTINATION_REVOKED throw aborts before any tx
  // record exists. On idempotent replay, sync is a cheap one-RPC no-op
  // (`isWalletOnList` returns true) since the original call drove the
  // wallet on-chain.
  const signer = await createOrgSigner(c.env, auth.organizationId, auth.projectId, signingWalletId);
  const mosaic = createIssuanceMosaicService(c, signer, "sponsored");
  const addedToAllowlist = ablListAddress
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

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "mint",
    mode: "execute",
    params: input,
  });

  // Create transaction record after sync so a sync-time error does not poison
  // the idempotency slot.
  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
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

  const auditService = new AuditService(getDb(c.env));
  if (replayed) {
    const replayedTransaction = await recoverSettledMintReplay(auditService, tokenService, tx);
    const txTokenAccount =
      typeof replayedTransaction.params.tokenAccount === "string"
        ? replayedTransaction.params.tokenAccount
        : undefined;
    return success(c, {
      transaction: replayedTransaction,
      tokenAccount: txTokenAccount === undefined ? input.mint.destination : txTokenAccount,
    });
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
  try {
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
      transaction: settledTransaction,
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
