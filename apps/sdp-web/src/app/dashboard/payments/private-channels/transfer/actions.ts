"use server";

import type { PrivateChannelTransfer, PrivateChannelTransferRecipientDto } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import {
  createPrivateChannelTransfer,
  fetchPrivateChannelTransferRecipients,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { getAmountError } from "../amount-validation";

export interface CreateTransferInput {
  channelId: string;
  walletId: string;
  recipientVerifiedWalletId: string;
  amount: string;
  /** Selected token mint; forwarded as-is for the API to validate. */
  mint?: string;
}

/**
 * Validation failures carry a `messageKey` for the client to translate; server
 * failures carry already-formatted text from the API, which has no key.
 */
export type CreateTransferResult =
  | { ok: true; transfer: PrivateChannelTransfer }
  | { ok: false; kind: "validation"; messageKey: MessageKey }
  | { ok: false; kind: "server"; message: string };

export type FetchTransferRecipientsResult =
  | { ok: true; recipients: PrivateChannelTransferRecipientDto[] }
  | { ok: false; messageKey: MessageKey }
  | { ok: false; message: string };

export async function createTransferAction(
  input: CreateTransferInput
): Promise<CreateTransferResult> {
  if (!input.channelId) {
    return {
      ok: false,
      kind: "validation",
      messageKey: "DashboardPrivateChannels.transfer.selectChannel",
    };
  }
  if (!input.walletId) {
    return {
      ok: false,
      kind: "validation",
      messageKey: "DashboardPrivateChannels.transfer.selectSourceWallet",
    };
  }
  if (!input.recipientVerifiedWalletId) {
    return {
      ok: false,
      kind: "validation",
      messageKey: "DashboardPrivateChannels.transfer.selectRecipient",
    };
  }
  const amountError = getAmountError(input.amount);
  if (amountError) {
    return { ok: false, kind: "validation", messageKey: amountError };
  }
  try {
    const client = await createSdpApiClient();
    const transfer = await createPrivateChannelTransfer(client, input.channelId, {
      walletId: input.walletId,
      recipientVerifiedWalletId: input.recipientVerifiedWalletId,
      amount: input.amount.trim(),
      ...(input.mint ? { mint: input.mint } : {}),
    });
    return { ok: true, transfer };
  } catch (error) {
    return { ok: false, kind: "server", message: extractSdpApiErrorMessage(error) };
  }
}

export async function fetchTransferRecipientsAction(
  channelId: string
): Promise<FetchTransferRecipientsResult> {
  if (!channelId) {
    return {
      ok: false,
      messageKey: "DashboardPrivateChannels.transfer.selectChannelForRecipients",
    };
  }
  try {
    const client = await createSdpApiClient();
    const recipients = await fetchPrivateChannelTransferRecipients(client, channelId);
    return { ok: true, recipients };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
