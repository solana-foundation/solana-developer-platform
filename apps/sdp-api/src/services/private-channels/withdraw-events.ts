/**
 * Withdrawal → activity-event emission.
 *
 * Emits `transfer.withdrawal.*` events into the Private Channels activity log
 * (`private_channel_events`) so withdrawals appear on the Events page/API. Uses
 * the runtime event service built from `env` — usable from both the request path
 * (withdrawal service) and the cron reconciler (no request context). Best-effort:
 * `PrivateChannelEventService.emit` isolates sink failures and never bubbles.
 */

import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  type PrivateChannelEventStatus,
  type PrivateChannelEventType,
} from "@sdp/types";
import type { PrivateChannelWithdrawalRow } from "@/db/repositories";
import { createPrivateChannelEventService } from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";

export async function emitWithdrawalEvent(
  env: Env,
  withdrawal: PrivateChannelWithdrawalRow,
  type: PrivateChannelEventType,
  status: PrivateChannelEventStatus,
  extra?: Record<string, unknown>
): Promise<void> {
  await createPrivateChannelEventService(env).emit({
    organizationId: withdrawal.organization_id,
    projectId: withdrawal.project_id,
    instanceId: withdrawal.instance_id,
    family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
    type,
    status,
    payload: {
      withdrawalId: withdrawal.id,
      amount: withdrawal.amount,
      mint: withdrawal.mint,
      owner: withdrawal.owner,
      destination: withdrawal.destination,
      ...extra,
    },
  });
}
