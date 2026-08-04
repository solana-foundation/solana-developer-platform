import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelTransferRow } from "@/db/repositories";
import * as eventService from "@/services/private-channels/event.service";
import type { Env } from "@/types/env";
import { emitTransferEvent } from "./transfer-events";

const ENV = {} as Env;
const SIGNATURE = "transfer-signature";

const TRANSFER: PrivateChannelTransferRow = {
  id: "pct_event_test",
  organization_id: "org_event_test",
  project_id: "prj_event_test",
  instance_id: "pci_event_test",
  channel_id: "pch_event_test",
  sender_private_channel_user_id: "pcu_sender",
  recipient_private_channel_user_id: "pcu_recipient",
  sender_wallet_id: "wallet_sender",
  recipient_verified_wallet_id: "pcvw_recipient",
  sender: "7HkZpV2gWQJnJHJFQWsvzY2dxbCPmnbMAxcr9m1DF3sG",
  recipient: "4Nd1mYB7RzSdyWLdgS2vFfrZAzifV44vCV9NFV1mCMbV",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  amount: "2.5",
  status: "submitted",
  signature: SIGNATURE,
  failure_reason: null,
  created_at: "2026-07-28T10:00:00.000Z",
  updated_at: "2026-07-28T10:00:00.000Z",
};

let emit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emit = vi.fn(async () => undefined);
  vi.spyOn(eventService, "createPrivateChannelEventService").mockReturnValue({
    emit,
  } as unknown as eventService.PrivateChannelEventService);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitTransferEvent", () => {
  it("emits a channel-scoped transfer event with the financial payload", async () => {
    await emitTransferEvent(ENV, TRANSFER, "transfer.transfer.submitted", "pending");

    expect(emit).toHaveBeenCalledWith({
      organizationId: "org_event_test",
      projectId: "prj_event_test",
      instanceId: "pci_event_test",
      channelId: "pch_event_test",
      sdpUserId: null,
      family: "transfer",
      type: "transfer.transfer.submitted",
      status: "pending",
      payload: {
        transferId: "pct_event_test",
        sender: TRANSFER.sender,
        recipient: TRANSFER.recipient,
        amount: "2.5",
        mint: TRANSFER.mint,
        signature: SIGNATURE,
      },
    });
  });

  it("keeps event delivery best-effort", async () => {
    emit.mockRejectedValueOnce(new Error("event sink unavailable"));

    await expect(
      emitTransferEvent(ENV, TRANSFER, "transfer.transfer.submitted", "pending")
    ).resolves.toBeUndefined();
  });
});
