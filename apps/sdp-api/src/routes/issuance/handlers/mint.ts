import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { assertValidAddress } from "@/lib/solana";
import { resolveApiKeySigningWalletId } from "@/services/api-key-scope.service";
import { AuditService } from "@/services/audit.service";
import { createMosaicService } from "@/services/mosaic";
import { createOrgSigner } from "@/services/solana";
import { createRpc, simulateTransaction } from "@/services/solana/rpc";
import { TokenService } from "@/services/token.service";
import { resolveMintOperationAmount } from "@/services/token-operation.service";
import type { Env } from "@/types/env";
import { mintSchema } from "../schemas";
import {
  assertDestinationAllowedByControlList,
  getOnChainAllowlistMutationForMint,
} from "./access-control";
import { buildIdempotencyMetadata } from "./idempotency";

type AppContext = Context<{ Bindings: Env }>;

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
  mosaic: ReturnType<typeof createMosaicService>;
  tokenId: string;
  ablListAddress: string;
  destinationRaw: string;
  destination: ReturnType<typeof assertValidAddress>;
  addedBy: string;
}): Promise<boolean> {
  const listAddress = assertValidAddress(opts.ablListAddress, "ablListAddress");

  if (await opts.mosaic.isWalletOnList(listAddress, opts.destination)) {
    try {
      await opts.tokenService.addAllowlistEntry({
        tokenId: opts.tokenId,
        address: opts.destinationRaw,
        addedBy: opts.addedBy,
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === "ADDRESS_ALREADY_ALLOWLISTED")) {
        throw error;
      }
    }
    return false;
  }

  let createdEntryId: string | null = null;
  try {
    const entry = await opts.tokenService.addAllowlistEntry({
      tokenId: opts.tokenId,
      address: opts.destinationRaw,
      addedBy: opts.addedBy,
    });
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
    // If on-chain membership now holds, both layers are consistent — the DB row
    // already exists at this point (we created it or a parallel request did),
    // so treat this as a successful sync rather than rolling back into drift.
    if (await opts.mosaic.isWalletOnList(listAddress, opts.destination)) {
      return true;
    }
    if (createdEntryId) {
      try {
        await opts.tokenService.revokeAllowlistEntry(createdEntryId);
      } catch (revokeError) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Failed to roll back control-list entry after mint sync error",
          {
            originalError: error instanceof Error ? error.message : "Unknown add error",
            restoreError:
              revokeError instanceof Error ? revokeError.message : "Unknown rollback error",
          }
        );
      }
    }
    throw error;
  }

  return true;
}

export const prepareMint = async (c: AppContext) => {
  const { tokenId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = mintSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const { mintAddress: mintAddressRaw, mosaicAmount } = resolveMintOperationAmount(
    token,
    parsed.data.mint.amount
  );

  const ablListAddress = getOnChainAllowlistMutationForMint(token, c.env.SOLANA_NETWORK);
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
  const mosaic = createMosaicService(c.env, signer);

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

  // Create transaction record with serialized tx
  const { transaction: tx } = await tokenService.createTransaction({
    tokenId,
    organizationId: auth.organizationId,
    type: "mint",
    params: {
      destination: parsed.data.mint.destination,
      amount: parsed.data.mint.amount,
      memo: parsed.data.mint.memo,
    },
    serializedTx: prepared.serializedTx,
    initiatedByKeyId: auth.id,
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
    transaction: tx,
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
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = mintSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const tokenService = new TokenService(getDb(c.env));
  const token = await tokenService.getToken(tokenId);

  if (!token || token.organizationId !== auth?.organizationId) {
    throw notFound("Token");
  }

  if (token.projectId !== auth.projectId) {
    throw notFound("Token");
  }

  const { mintAddress: mintAddressRaw, mosaicAmount } = resolveMintOperationAmount(
    token,
    parsed.data.mint.amount
  );

  const ablListAddress = getOnChainAllowlistMutationForMint(token, c.env.SOLANA_NETWORK);
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

  const idempotencyMetadata = buildIdempotencyMetadata(c.req.header("Idempotency-Key"), {
    tokenId,
    operation: "mint",
    mode: "execute",
    params: parsed.data,
  });

  // Create transaction record first
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

  try {
    // Get custody signer (via 3-tier resolution)
    const signer = await createOrgSigner(
      c.env,
      auth.organizationId,
      auth.projectId,
      signingWalletId
    );

    // Execute mint on Solana using Mosaic
    // Note: amount is decimal (e.g., 100 for 100 tokens), SDK converts to raw
    const mosaic = createMosaicService(c.env, signer);

    // For allowlist tokens with on-chain ABL, sync the destination wallet to
    // the on-chain list before minting so the SDK's permissionless-thaw can
    // succeed for a fresh ATA.
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

    const result = await mosaic.mintTo({
      mint: mintAddress,
      destination,
      amount: mosaicAmount,
      mintAuthority: signer.address,
      feePayer: signer.address,
    });

    // Update transaction with confirmation
    // Update token supply
    await tokenService.updateSupply(tokenId, parsed.data.mint.amount, "mint");

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
    // Update transaction as failed
    await tokenService.updateTransaction(tx.id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
};
