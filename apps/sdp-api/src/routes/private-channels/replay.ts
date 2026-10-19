import type { PrivateChannelDepositRow } from "@/db/repositories/private-channel-deposit.repository";
import type { PrivateChannelTransferRow } from "@/db/repositories/private-channel-transfer.repository";
import type { PrivateChannelWithdrawalRow } from "@/db/repositories/private-channel-withdrawal.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, conflict } from "@/lib/errors";
import {
  buildPrivateChannelDepositFingerprint,
  buildPrivateChannelTransferFingerprint,
  buildPrivateChannelWithdrawalFingerprint,
} from "@/lib/idempotency";
import { callerMayPerform } from "@/middleware/require-action";
import { refreshPrivateChannelAuth } from "@/services/private-channels/wallet-access";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { AppContext } from "./context";

/** Every movement POST, including replay, requires `private_channels.execute`, re-read now. */
export async function requireMovementWrite(c: AppContext): Promise<void> {
  const auth = getAuth(c);
  if (auth.authType === "api_key") {
    const current = await refreshPrivateChannelAuth(c.env, auth, requireProjectId(c));
    const key = c.get("apiKey");
    if (key && current.grants) c.set("apiKey", { ...key, grants: current.grants });
  }
  if (!callerMayPerform(c, "private_channels.execute")) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Missing action: private_channels.execute", {
      action: "private_channels.execute",
    });
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
