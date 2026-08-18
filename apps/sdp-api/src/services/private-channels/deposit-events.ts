/**
 * Deposit → activity-event emission.
 *
 * Emits `transfer.deposit.*` events into the Private Channels activity log
 * (`private_channel_events`) so deposits appear on the Events page/API. Uses the
 * runtime event service built from `env` — usable from both the request path
 * (deposit service) and the cron reconciler (no request context). Best-effort:
 * `PrivateChannelEventService.emit` isolates sink failures and never bubbles.
 */

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  type PrivateChannelEventStatus,
  type PrivateChannelEventType,
} from "@sdp/types";
import type { PrivateChannelDepositRow } from "@/db/repositories";
import { createPrivateChannelEventService } from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";

export async function emitDepositEvent(
  env: Env,
  deposit: PrivateChannelDepositRow,
  type: PrivateChannelEventType,
  status: PrivateChannelEventStatus,
  extra?: Record<string, unknown>
): Promise<void> {
  await createPrivateChannelEventService(env).emit({
    organizationId: deposit.organization_id,
    projectId: deposit.project_id,
    instanceId: deposit.instance_id,
    channelId: null,
    sdpUserId: deposit.context.actingUserId ?? null,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
    type,
    status,
    payload: {
      depositId: deposit.id,
      senderWalletId: deposit.wallet_id,
      sender: deposit.depositor,
      amount: deposit.amount,
      mint: deposit.mint,
      recipient: deposit.recipient,
      ...extra,
    },
  });
}
