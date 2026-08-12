import { assertValidAddress } from "@sdp/solana/address";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { createMosaicService } from "@/services/issuance/mosaic";
import { createOrgSigner } from "@/services/solana";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";

/**
 * On-chain add for an allowlist row that was just inserted or reactivated,
 * with TOCTOU-safe rollback. Lifted out of the issuance route handler so both
 * the HTTP handler and the (context-less) workflow cron action share one
 * implementation — it takes `env` rather than a Hono `Context`.
 *
 * If `addToList` errors, re-checks `isWalletOnList`. When membership is
 * confirmed, the DB row is kept and success bubbles up. Otherwise the rollback
 * path depends on `wasReactivated`:
 *  - `false` (freshly inserted): hard-delete the row (a tombstone would block
 *    the mint auto-add guard).
 *  - `true` (reactivated from `revoked`): re-revoke to restore prior history.
 */
export async function syncNewAllowlistEntryOnChain(opts: {
  env: Env;
  organizationId: string;
  projectId: string;
  signingWalletId: string | null | undefined;
  tokenService: TokenService;
  entryId: string;
  wasReactivated: boolean;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<void> {
  const signer = await createOrgSigner(
    opts.env,
    opts.organizationId,
    opts.projectId,
    opts.signingWalletId ?? undefined
  );
  const mosaic = createMosaicService(opts.env, signer, "sponsored");

  try {
    await mosaic.addToList({ list: opts.list, wallet: opts.wallet });
  } catch (error) {
    if (await mosaic.isWalletOnList(opts.list, opts.wallet)) {
      return;
    }
    try {
      if (opts.wasReactivated) {
        await opts.tokenService.revokeAllowlistEntry(opts.entryId);
      } else {
        await opts.tokenService.deleteAllowlistEntry(opts.entryId);
      }
    } catch (rollbackError) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to roll back control-list entry after sync error",
        {
          originalError: error instanceof Error ? error.message : "Unknown add error",
          restoreError:
            rollbackError instanceof Error ? rollbackError.message : "Unknown rollback error",
        }
      );
    }
    throw error;
  }
}

export type AllowlistSyncStatus = "added" | "already_present" | "failed";

export interface AllowlistSyncResult {
  status: AllowlistSyncStatus;
  entryId?: string;
  error?: string;
}

/**
 * Headless "add a wallet to a token's allowlist" — resolve the token, insert the
 * DB row, then sync on-chain with rollback. Used by the workflow allowlist action
 * (no HTTP context). Returns a result instead of throwing; treats an already-present
 * wallet as SUCCESS so a manual retry after a partial success converges.
 */
export async function addAndSyncAllowlistEntry(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  tokenId: string;
  walletAddress: string;
  label?: string | null;
  addedBy: string;
}): Promise<AllowlistSyncResult> {
  const tokenService = new TokenService(getDb(input.env));
  const token = await tokenService.getToken({
    tokenId: input.tokenId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!token) {
    return { status: "failed", error: "TOKEN_NOT_FOUND" };
  }

  try {
    const { entry, wasReactivated } = await tokenService.addAllowlistEntry({
      tokenId: input.tokenId,
      address: input.walletAddress,
      addedBy: input.addedBy,
      label: input.label ?? undefined,
    });

    if (token.ablListAddress) {
      await syncNewAllowlistEntryOnChain({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signingWalletId: token.signingWalletId,
        tokenService,
        entryId: entry.id,
        wasReactivated,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(input.walletAddress, "address"),
      });
    }

    return { status: "added", entryId: entry.id };
  } catch (error) {
    // Idempotent: an already-listed wallet is a converged success, not a failure.
    if (error instanceof Error && error.message === "ADDRESS_ALREADY_ALLOWLISTED") {
      return { status: "already_present" };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * On-chain removal counterpart to `syncNewAllowlistEntryOnChain`, env-based. Idempotent:
 * if `removeFromList` errors but the wallet is already off the list, the removal has
 * converged and we return cleanly rather than surfacing a spurious failure.
 */
async function removeAllowlistEntryOnChain(opts: {
  env: Env;
  organizationId: string;
  projectId: string;
  signingWalletId: string | null | undefined;
  list: ReturnType<typeof assertValidAddress>;
  wallet: ReturnType<typeof assertValidAddress>;
}): Promise<void> {
  const signer = await createOrgSigner(
    opts.env,
    opts.organizationId,
    opts.projectId,
    opts.signingWalletId ?? undefined
  );
  const mosaic = createMosaicService(opts.env, signer, "sponsored");

  try {
    await mosaic.removeFromList({ list: opts.list, wallet: opts.wallet });
  } catch (error) {
    if (!(await mosaic.isWalletOnList(opts.list, opts.wallet))) {
      return;
    }
    throw error;
  }
}

export type AllowlistRemoveStatus = "removed" | "already_absent" | "failed";

export interface AllowlistRemoveResult {
  status: AllowlistRemoveStatus;
  error?: string;
}

/**
 * Headless "remove a wallet from a token's allowlist" — the counterpart to
 * `addAndSyncAllowlistEntry`, used by the workflow `allowlist_remove` action. Removes
 * on-chain first (idempotent-tolerant), then revokes the DB row. A wallet with no active
 * entry is treated as SUCCESS (`already_absent`) so a manual retry converges.
 */
export async function removeAndSyncAllowlistEntry(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  tokenId: string;
  walletAddress: string;
}): Promise<AllowlistRemoveResult> {
  const tokenService = new TokenService(getDb(input.env));
  const token = await tokenService.getToken({
    tokenId: input.tokenId,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (!token) {
    return { status: "failed", error: "TOKEN_NOT_FOUND" };
  }

  try {
    if (token.ablListAddress) {
      await removeAllowlistEntryOnChain({
        env: input.env,
        organizationId: input.organizationId,
        projectId: input.projectId,
        signingWalletId: token.signingWalletId,
        list: assertValidAddress(token.ablListAddress, "ablListAddress"),
        wallet: assertValidAddress(input.walletAddress, "address"),
      });
    }

    const entryId = await tokenService.getActiveAllowlistEntryIdByAddress(
      input.tokenId,
      input.walletAddress
    );
    if (entryId) {
      await tokenService.revokeAllowlistEntry(entryId);
      return { status: "removed" };
    }
    return { status: "already_absent" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
