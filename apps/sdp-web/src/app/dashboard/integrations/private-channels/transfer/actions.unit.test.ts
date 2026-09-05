import type { PrivateChannelTransfer, PrivateChannelTransferRecipientDto } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  createPrivateChannelTransfer: vi.fn(),
  fetchPrivateChannelTransferRecipients: vi.fn(),
  extractSdpApiErrorMessage: vi.fn(),
}));

vi.mock("@/lib/private-channels", () => ({
  createPrivateChannelTransfer: mocks.createPrivateChannelTransfer,
  fetchPrivateChannelTransferRecipients: mocks.fetchPrivateChannelTransferRecipients,
}));
// `SdpApiResponseError` comes through unmocked: the action narrows on it to read
// the HTTP status that decides whether the browser may retire the idempotency
// key, so a stub class here would only test the stub.
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
  extractSdpApiErrorMessage: mocks.extractSdpApiErrorMessage,
}));

import { createTransferAction, fetchTransferRecipientsAction } from "./actions";

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

const recipients: PrivateChannelTransferRecipientDto[] = [
  {
    id: "pcvw_recipient",
    pubkey: transfer.recipient,
    walletName: "Recipient wallet",
    privateChannelUserId: "pcu_recipient",
    isSelf: false,
  },
];

describe("private-channel transfer actions", () => {
  const client = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
    mocks.extractSdpApiErrorMessage.mockImplementation((error: unknown) =>
      error instanceof Error ? error.message : "Unknown error."
    );
  });

  it.each([
    [
      {
        channelId: "",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1",
        idempotencyKey: "idem_transfer_unit",
      },
      "DashboardPrivateChannels.transfer.selectChannel",
    ],
    [
      {
        channelId: "channel_alpha",
        walletId: "",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1",
        idempotencyKey: "idem_transfer_unit",
      },
      "DashboardPrivateChannels.transfer.selectSourceWallet",
    ],
    [
      {
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "",
        amount: "1",
        idempotencyKey: "idem_transfer_unit",
      },
      "DashboardPrivateChannels.transfer.selectRecipient",
    ],
    [
      {
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1.0000001",
        idempotencyKey: "idem_transfer_unit",
      },
      "DashboardPrivateChannels.common.amountInvalid",
    ],
  ])("rejects invalid financial input %#", async (input, messageKey) => {
    await expect(createTransferAction(input)).resolves.toEqual({
      ok: false,
      kind: "validation",
      messageKey,
    });
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
  });

  it("passes the normalized amount to the API helper", async () => {
    mocks.createPrivateChannelTransfer.mockResolvedValue(transfer);

    await expect(
      createTransferAction({
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: " 1.25 ",
        idempotencyKey: "idem_transfer_unit",
      })
    ).resolves.toEqual({ ok: true, transfer });

    // The key travels as a HEADER argument, never in the body: it is the
    // reservation, not part of the request payload.
    expect(mocks.createPrivateChannelTransfer).toHaveBeenCalledWith(
      client,
      "channel_alpha",
      {
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1.25",
      },
      "idem_transfer_unit"
    );
  });

  it("returns a recoverable server error", async () => {
    mocks.createPrivateChannelTransfer.mockRejectedValue(new Error("Gateway unavailable"));

    await expect(
      createTransferAction({
        channelId: "channel_alpha",
        walletId: "wallet_sender",
        recipientVerifiedWalletId: "pcvw_recipient",
        amount: "1",
        idempotencyKey: "idem_transfer_unit",
      })
    ).resolves.toEqual({
      ok: false,
      kind: "server",
      message: "Gateway unavailable",
      // A plain Error is not an API response: nothing proves the request was
      // never recorded, so the browser must KEEP the key and replay.
      status: null,
    });
  });

  it("loads recipients and exposes a retryable error", async () => {
    mocks.fetchPrivateChannelTransferRecipients.mockResolvedValueOnce(recipients);
    await expect(fetchTransferRecipientsAction("channel_alpha")).resolves.toEqual({
      ok: true,
      recipients,
    });

    mocks.fetchPrivateChannelTransferRecipients.mockRejectedValueOnce(
      new Error("Recipients unavailable")
    );
    await expect(fetchTransferRecipientsAction("channel_alpha")).resolves.toEqual({
      ok: false,
      message: "Recipients unavailable",
    });
  });
});
