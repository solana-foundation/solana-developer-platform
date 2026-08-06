import { PrivateChannelError } from "@sdp/private-channels";
import { PRIVATE_CHANNEL_EVENT_TYPES, type PrivateChannelVerifiedWalletDto } from "@sdp/types";
import type { PrivateChannelVerifiedWalletRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import {
  deletePrivateChannelWallet,
  listPrivateChannelWallets,
  mapPrivateChannelError,
  verifyPrivateChannelWallet,
} from "@/services/private-channels";
import type { AppContext } from "../context";
import { emitMember, recordInstanceError, requireActiveInstance } from "../helpers";

function toVerifiedWalletDto(
  row: PrivateChannelVerifiedWalletRow
): PrivateChannelVerifiedWalletDto {
  return {
    id: row.id,
    walletId: row.wallet_id,
    pubkey: row.pubkey,
    verifiedAt: row.verified_at,
  };
}

/**
 * Best-effort: if the failure was the SPC auth service being unreachable, record
 * an instance error event. Never masks the original error.
 */
async function recordSpcUnreachable(c: AppContext, error: unknown): Promise<void> {
  if (!(error instanceof PrivateChannelError) || error.code !== "AUTH_UNAVAILABLE") {
    return;
  }
  try {
    const instance = await requireActiveInstance(c);
    await recordInstanceError(
      c,
      instance,
      PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
      error
    );
  } catch {
    // best-effort telemetry; swallow so the original error surfaces
  }
}

/** GET /wallets — list the caller's own verified wallets for this project. */
export async function listVerifiedWallets(c: AppContext) {
  const rows = await listPrivateChannelWallets(c.env, getAuth(c), requireProjectId(c));
  return success(c, { wallets: rows.map(toVerifiedWalletDto) });
}

/**
 * POST /wallets/:walletId/verify — run the SPC challenge → sign → verify
 * handshake for a custody wallet, then persist the verification. Idempotent.
 */
export async function verifyWallet(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const walletId = c.req.param("walletId");
  if (!walletId) {
    throw badRequest("walletId is required");
  }

  try {
    const { row, instance } = await verifyPrivateChannelWallet(c.env, auth, projectId, walletId);
    await emitMember(
      c,
      {
        organizationId: instance.organization_id,
        projectId: instance.project_id,
        instanceId: instance.id,
      },
      PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED,
      {
        payload: { walletId: row.wallet_id, pubkey: row.pubkey },
      }
    );
    return success(c, { wallet: toVerifiedWalletDto(row) });
  } catch (error) {
    await recordSpcUnreachable(c, error);
    // Only PrivateChannelError needs translating here; let AppError/SigningError
    // reach app.ts `onError` so it maps them to their proper status (e.g. 404).
    if (error instanceof PrivateChannelError) {
      throw mapPrivateChannelError(error);
    }
    throw error;
  }
}

/** DELETE /wallets/:pubkey — revoke a wallet verification with SPC and remove the row. */
export async function deleteVerifiedWallet(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const pubkey = c.req.param("pubkey");
  if (!pubkey) {
    throw badRequest("pubkey is required");
  }

  try {
    const { instance, deleted } = await deletePrivateChannelWallet(c.env, auth, projectId, pubkey);
    if (deleted) {
      await emitMember(
        c,
        {
          organizationId: instance.organization_id,
          projectId: instance.project_id,
          instanceId: instance.id,
        },
        PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFICATION_REVOKED,
        { payload: { pubkey } }
      );
    }
    return success(c, { deleted });
  } catch (error) {
    await recordSpcUnreachable(c, error);
    if (error instanceof PrivateChannelError) {
      throw mapPrivateChannelError(error);
    }
    throw error;
  }
}
