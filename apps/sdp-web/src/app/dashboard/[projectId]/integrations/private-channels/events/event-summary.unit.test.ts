import { PRIVATE_CHANNEL_EVENT_FAMILIES, PRIVATE_CHANNEL_EVENT_TYPES } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { summarizePrivateChannelEvent } from "./event-summary";

const SENDER = "Sender1111111111111111111111111111111111";
const RECIPIENT = "Recipient11111111111111111111111111111111";
const MINT = "Mint11111111111111111111111111111111111111";

describe("summarizePrivateChannelEvent", () => {
  it("extracts a wallet-to-wallet transfer without shortening detail values", () => {
    const signature = "Signature111111111111111111111111111111111111111111111111";

    expect(
      summarizePrivateChannelEvent({
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
        payload: {
          transferId: "pct_transfer",
          amount: "12.50",
          mint: MINT,
          sender: SENDER,
          recipient: RECIPIENT,
          signature,
        },
      })
    ).toEqual({
      kind: "transfer",
      amount: "12.50",
      mint: MINT,
      sender: SENDER,
      recipient: RECIPIENT,
      signature,
      ids: { transferId: "pct_transfer" },
    });
  });

  it("extracts deposit and withdrawal directions and failure reasons", () => {
    const deposit = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_SETTLED,
      payload: {
        depositId: "pcd_deposit",
        sender: SENDER,
        recipient: RECIPIENT,
        amount: "3.25",
        mint: MINT,
      },
    });
    const withdrawal = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_WITHDRAWAL_FAILED,
      payload: {
        withdrawalId: "pcw_withdrawal",
        sender: SENDER,
        recipient: RECIPIENT,
        amount: "1.75",
        mint: MINT,
        failureReason: "Release transaction expired",
      },
    });

    expect(deposit).toMatchObject({
      kind: "deposit",
      sender: SENDER,
      recipient: RECIPIENT,
      ids: { depositId: "pcd_deposit" },
    });
    expect(withdrawal).toMatchObject({
      kind: "withdrawal",
      sender: SENDER,
      recipient: RECIPIENT,
      reason: "Release transaction expired",
      ids: { withdrawalId: "pcw_withdrawal" },
    });
  });

  it("extracts wallet and channel lifecycle payloads", () => {
    const wallet = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.MEMBER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.MEMBER_WALLET_VERIFIED,
      payload: { walletId: "wallet_1", pubkey: RECIPIENT },
    });
    const channel = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
      type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_CHANNEL_CREATED,
      payload: { name: "Treasury" },
    });

    expect(wallet).toEqual({
      kind: "wallet",
      pubkey: RECIPIENT,
      ids: { walletId: "wallet_1" },
    });
    expect(channel).toEqual({
      kind: "channel",
      channelName: "Treasury",
      ids: {},
    });
  });

  it("extracts instance and error details from alternate payload keys", () => {
    const instance = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.LIFECYCLE,
      type: PRIVATE_CHANNEL_EVENT_TYPES.LIFECYCLE_INSTANCE_CONNECTED,
      payload: {
        gatewayUrl: "https://gateway.example",
        latencyMs: 42,
      },
    });
    const error = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.ERROR,
      type: PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
      payload: {
        reason: "Gateway timed out",
        message: "Lower-priority fallback",
      },
    });

    expect(instance).toEqual({
      kind: "instance",
      gatewayUrl: "https://gateway.example",
      latencyMs: "42",
      ids: {},
    });
    expect(error).toEqual({
      kind: "error",
      reason: "Gateway timed out",
      ids: {},
    });
  });

  it("ignores malformed known fields and unknown payload shapes", () => {
    const malformed = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_FAILED,
      payload: {
        amount: { value: "1.00" },
        sender: ["not", "an", "address"],
        recipient: null,
        failureReason: { message: "nested" },
      },
    });
    const unknown = summarizePrivateChannelEvent({
      family: "future-family",
      type: "future.event",
      payload: null,
    });

    expect(malformed).toEqual({ kind: "transfer", ids: {} });
    expect(unknown).toEqual({ kind: "unknown", ids: {} });
    expect(JSON.stringify(malformed)).not.toContain("[object Object]");
  });

  it("rejects numeric values for string-only fields", () => {
    const malformed = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_TRANSFER_CONFIRMED,
      payload: {
        amount: 125,
        recipient: 123,
        transferId: 456,
        signature: 789,
        latencyMs: 42,
      },
    });

    expect(malformed).toEqual({
      kind: "transfer",
      latencyMs: "42",
      ids: {},
    });
  });

  it("retains long values for full detail rendering", () => {
    const longReason = "A".repeat(500);
    const longAddress = "B".repeat(256);

    const summary = summarizePrivateChannelEvent({
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      type: PRIVATE_CHANNEL_EVENT_TYPES.TRANSFER_DEPOSIT_FAILED,
      payload: {
        recipient: longAddress,
        reason: longReason,
      },
    });

    expect(summary.recipient).toBe(longAddress);
    expect(summary.reason).toBe(longReason);
  });
});
