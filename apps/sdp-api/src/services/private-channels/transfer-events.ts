import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  type PrivateChannelEventStatus,
  type PrivateChannelEventType,
} from "@sdp/types";
import type { PrivateChannelTransferRow } from "@/db/repositories";
import { createPrivateChannelEventService } from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";

/** Emit one transfer lifecycle event without letting activity-log failures affect funds flow. */
export async function emitTransferEvent(
  env: Env,
  transfer: PrivateChannelTransferRow,
  type: PrivateChannelEventType,
  status: PrivateChannelEventStatus,
  sdpUserId: string
): Promise<void> {
  try {
    await createPrivateChannelEventService(env).emit({
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      instanceId: transfer.instance_id,
      // Transfers belong to their initiating user and wallets, not a single channel.
      channelId: null,
      sdpUserId,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type,
      status,
      payload: {
        transferId: transfer.id,
        senderWalletId: transfer.sender_wallet_id,
        sender: transfer.sender,
        recipient: transfer.recipient,
        amount: transfer.amount,
        mint: transfer.mint,
        signature: transfer.signature,
      },
    });
  } catch {
    // Event delivery is best-effort. The event service logs individual sink failures.
  }
}
