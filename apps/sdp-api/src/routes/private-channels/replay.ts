import { hasAllPermissions } from "@sdp/types";
import type {
  PrivateChannelDepositRow,
  PrivateChannelTransferRow,
  PrivateChannelWithdrawalRow,
} from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, conflict } from "@/lib/errors";
import {
  buildPrivateChannelDepositFingerprint,
  buildPrivateChannelTransferFingerprint,
  buildPrivateChannelWithdrawalFingerprint,
} from "@/lib/idempotency";
import { refreshPrivateChannelAuth } from "@/services/private-channels/wallet-access";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";

/** Every movement POST, including replay, requires current write access. */
export async function requireMovementWrite(c: AppContext): Promise<void> {
  const auth = getAuth(c);
  if (auth.authType === "api_key") {
    const current = await refreshPrivateChannelAuth(c.env, auth, requireProjectId(c));
    const key = c.get("apiKey");
    if (key) c.set("apiKey", { ...key, permissions: current.permissions });
  }
  if (!hasAllPermissions(getAuth(c).permissions, ["payments:write"])) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: payments:write");
  }
}

type MovementRow =
  | PrivateChannelDepositRow
  | PrivateChannelWithdrawalRow
  | PrivateChannelTransferRow;

/** Replay and recovery authorize the historical source, never its replacement. */
export async function authorizeMovementReplay<
  T extends { wallet: CustodyWallet; instance: { id: string } },
>(c: AppContext, row: MovementRow, authorizeWrite: () => Promise<T>): Promise<T> {
  await requireMovementWrite(c);
  const context = await authorizeWrite();
  const walletId = "sender_wallet_id" in row ? row.sender_wallet_id : row.wallet_id;
  const publicKey = "depositor" in row ? row.depositor : "owner" in row ? row.owner : row.sender;
  if (
    context.wallet.walletId !== walletId ||
    context.wallet.publicKey !== publicKey ||
    context.instance.id !== row.instance_id
  ) {
    throw conflict("The original operation's source wallet cannot be authorized");
  }
  return context;
}

export function matchesWithdrawalReplay(
  row: PrivateChannelWithdrawalRow,
  input: {
    walletId: string;
    amount: string;
    mint?: string;
    /** Resolved by the access seam from the body, exactly as on the first request. */
    destination: string;
  }
): void {
  if (
    (input.walletId !== row.wallet_id && input.walletId !== row.owner) ||
    row.idempotency_fingerprint !==
      buildPrivateChannelWithdrawalFingerprint({
        instanceId: row.instance_id,
        walletId: row.wallet_id,
        destination: input.destination,
        mint: input.mint ?? row.mint,
        amount: input.amount,
      })
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
}

export function matchesTransferReplay(
  row: PrivateChannelTransferRow,
  input: {
    channelId: string;
    walletId: string;
    recipientVerifiedWalletId: string;
    amount: string;
    mint?: string;
  }
): void {
  if (
    input.walletId !== row.sender_wallet_id ||
    row.idempotency_fingerprint !==
      buildPrivateChannelTransferFingerprint({
        instanceId: row.instance_id,
        channelId: input.channelId,
        walletId: input.walletId,
        recipientVerifiedWalletId: input.recipientVerifiedWalletId,
        mint: input.mint ?? row.mint,
        amount: input.amount,
      })
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
}

export function matchesDepositReplay(
  row: PrivateChannelDepositRow,
  input: {
    walletId: string;
    amount: string;
    mint?: string;
    /** Resolved by the access seam from the body, exactly as on the first request. */
    recipient: string;
  }
): void {
  if (
    (input.walletId !== row.wallet_id && input.walletId !== row.depositor) ||
    row.idempotency_fingerprint !==
      buildPrivateChannelDepositFingerprint({
        instanceId: row.instance_id,
        walletId: row.wallet_id,
        recipient: input.recipient,
        mint: input.mint ?? row.mint,
        amount: input.amount,
      })
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
}
