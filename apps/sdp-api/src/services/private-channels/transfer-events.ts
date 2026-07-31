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
  status: PrivateChannelEventStatus
): Promise<void> {
  try {
    await createPrivateChannelEventService(env).emit({
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      instanceId: transfer.instance_id,
      channelId: transfer.channel_id,
      // The transfer row records the acting SPC member, not an SDP user id.
      sdpUserId: null,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type,
      status,
      payload: {
        transferId: transfer.id,
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
