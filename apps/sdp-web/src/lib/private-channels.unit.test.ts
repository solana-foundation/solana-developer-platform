import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  type PrivateChannelEventListEnvelope,
  type PrivateChannelTransfer,
  type PrivateChannelTransferRecipientDto,
  type PrivateChannelUserDto,
} from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import {
  createPrivateChannelTransfer,
  fetchAuthenticatedPrivateChannelUser,
  fetchPrivateChannelEvents,
  fetchPrivateChannelTransferRecipients,
} from "./private-channels";

function createClient(response: unknown): SdpApiClient {
  return {
    request: vi.fn(),
    fetch: vi.fn().mockResolvedValue(response),
  };
}

const member: PrivateChannelUserDto = {
  id: "pcu_sender",
  userId: "user_sender",
  email: "sender@example.com",
  name: "Sender",
  projectRole: null,
  verifiedWalletCount: 1,
  invitedAt: "2026-07-28T00:00:00.000Z",
  channels: [
    {
      id: "channel_alpha",
      name: "Alpha",
      isDefault: true,
    },
  ],
};

const recipients: PrivateChannelTransferRecipientDto[] = [
  {
    id: "pcvw_recipient",
    pubkey: "Recipient11111111111111111111111111111111",
    walletName: "Recipient wallet",
    privateChannelUserId: "pcu_recipient",
    isSelf: false,
  },
];

const transfer: PrivateChannelTransfer = {
  id: "pct_test",
  organizationId: "org_test",
  projectId: "project_test",
  instanceId: "pci_test",
  channelId: "channel_alpha",
  walletId: "wallet_sender",
  sender: "Sender1111111111111111111111111111111111",
  recipient: "Recipient11111111111111111111111111111111",
  mint: "Usdc111111111111111111111111111111111111",
  amount: "1.25",
  status: "submitted",
  signature: "signature",
  failureReason: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const eventEnvelope: PrivateChannelEventListEnvelope = {
  events: [],
  hasMore: false,
  nextCursor: null,
};

describe("private-channel transfer API helpers", () => {
  it("returns the authenticated member and their eligible channels", async () => {
    const client = createClient({ user: member });

    await expect(fetchAuthenticatedPrivateChannelUser(client)).resolves.toEqual(member);
    expect(client.fetch).toHaveBeenCalledWith("/v1/private-channels/users/me");
  });

  it("returns null when the authenticated user is not a private-channel member", async () => {
    const client = createClient({ user: null });

    await expect(fetchAuthenticatedPrivateChannelUser(client)).resolves.toBeNull();
  });

  it("loads grouped verified recipients for the selected channel", async () => {
    const client = createClient({ recipients });

    await expect(fetchPrivateChannelTransferRecipients(client, "channel/alpha")).resolves.toEqual(
      recipients
    );
    expect(client.fetch).toHaveBeenCalledWith(
      "/v1/private-channels/channels/channel%2Falpha/transfer-recipients"
    );
  });

  it("creates a transfer with the opaque recipient id", async () => {
    const client = createClient(transfer);

    await expect(
      createPrivateChannelTransfer(client, "channel/alpha", {
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1.25",
      })
    ).resolves.toEqual(transfer);
    expect(client.fetch).toHaveBeenCalledWith(
      "/v1/private-channels/channels/channel%2Falpha/transfers",
      {
        method: "POST",
        body: JSON.stringify({
          walletId: "wallet_sender",
          recipientVerifiedWalletId: "pcvw_recipient",
          amount: "1.25",
        }),
      }
    );
  });
});

describe("private-channel event API helpers", () => {
  it("appends typed family, status, and cursor filters", async () => {
    const client = createClient(eventEnvelope);

    await expect(
      fetchPrivateChannelEvents(client, {
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
        type: "error.spc_unreachable",
        limit: 25,
        before: "cursor/with space",
      })
    ).resolves.toEqual(eventEnvelope);

    expect(client.fetch).toHaveBeenCalledWith(
      "/v1/private-channels/events?family=error&type=error.spc_unreachable&status=failed&limit=25&before=cursor%2Fwith+space"
    );
  });
});
