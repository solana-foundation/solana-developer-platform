import { createRpc, simulateTransaction } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getLogger } from "@/runtime/logger";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createOrgSigner } from "@/services/solana";
import type { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
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
import { enforceIssuanceWalletOperationPolicy } from "./policy";

type AppContext = Context<{ Bindings: Env }>;

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

  // For allowlist tokens with on-chain ABL, sync the destination wallet to
  // the on-chain list (and DB mirror) before preparing the mint tx so the
  // SDK's permissionless-thaw can succeed when the client submits.
  const addedToAllowlist = ablListAddress
    ? await syncDestinationToOnChainAllowlist({
        tokenService,
        mosaic,
        tokenId,
        ablListAddress,
        destinationRaw: parsed.data.mint.destination,
        destination,
        addedBy: auth.id,
      })
    : false;

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
      addedToAllowlist,
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

export const executeMint = async (c: AppContext) => {
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
  const mintAddress = assertValidAddress(mintAddressRaw, "mintAddress");
  const destination = assertValidAddress(parsed.data.mint.destination, "destination");

  await enforceIssuanceWalletOperationPolicy(c, {
    auth,
    token,
    walletId: signingWalletId,
    operationType: "issuance_mint_execute",
    amount: parsed.data.mint.amount,
    destination: parsed.data.mint.destination,
    rawPayload: {
      action: "mint",
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo ?? null,
    },
  });

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
        tokenService,
        mosaic,
        tokenId,
        ablListAddress,
        destinationRaw: parsed.data.mint.destination,
        destination,
        addedBy: auth.id,
      })
    : false;

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "mint",
    mode: "execute",
    params: parsed.data,
  });

  // Create transaction record after sync so a sync-time error does not poison
  // the idempotency slot.
  const { transaction: tx, replayed } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
    },
    initiatedByKeyId: auth.id,
    idempotencyKey: idempotencyMetadata.idempotencyKey,
    idempotencyFingerprint: idempotencyMetadata.idempotencyFingerprint,
  });

  if (replayed) {
    const txTokenAccount =
      typeof tx.params.tokenAccount === "string" ? tx.params.tokenAccount : undefined;
    return success(c, {
      transaction: tx,
      tokenAccount: txTokenAccount ?? parsed.data.mint.destination,
    });
  }

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
        reservedSupply = await tokenService.reserveMintSupply(tokenId, amountBaseUnits.toString());
        if (reservedSupply === null) {
          throw new AppError("MAX_SUPPLY_EXCEEDED", "Mint amount would exceed maximum supply");
        }
      }
    );

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
        signature: result.signature,
        slot: result.slot.toString(),
        mode: "execute",
        addedToAllowlist,
      },
    });

    return success(c, {
      transaction: await tokenService.updateTransaction(tx.id, {
        status: "confirmed",
        signature: result.signature,
        slot: Number(result.slot),
        params: {
          ...tx.params,
          tokenAccount: result.tokenAccount,
        },
      }),
      tokenAccount: result.tokenAccount,
    });
  } catch (error) {
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
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
