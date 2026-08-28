"use server";

import type { PrivateChannelTransfer, PrivateChannelTransferRecipientDto } from "@sdp/types";
import type { MessageKey } from "@/i18n/messages";
import {
  createPrivateChannelTransfer,
  fetchPrivateChannelTransferRecipients,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage, SdpApiResponseError } from "@/lib/sdp-api";
import { getAmountError } from "../amount-validation";

export interface CreateTransferInput {
  channelId: string;
  walletId: string;
  recipientVerifiedWalletId: string;
  amount: string;
  /** Selected token mint; forwarded as-is for the API to validate. */
  mint?: string;
  /**
   * Minted in the BROWSER and passed in, never generated here: this action runs
   * once per invocation, so a key it created would be fresh on every retry —
   * which is exactly a second spend. See `../value-movement-tracking`.
   */
  idempotencyKey: string;
}

/**
 * Validation failures carry a `messageKey` for the client to translate; server
 * failures carry already-formatted text from the API, which has no key.
 *
 * `status` rides along on a server failure so the browser can decide whether to
 * retire the idempotency key — see the deposit action for the full reasoning.
 */
export type CreateTransferResult =
  | { ok: true; transfer: PrivateChannelTransfer }
  | { ok: false; kind: "validation"; messageKey: MessageKey }
  | { ok: false; kind: "server"; message: string; status: number | null };

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
    const transfer = await createPrivateChannelTransfer(
      client,
      input.channelId,
      {
        walletId: input.walletId,
        recipientVerifiedWalletId: input.recipientVerifiedWalletId,
        amount: input.amount.trim(),
        ...(input.mint ? { mint: input.mint } : {}),
      },
      input.idempotencyKey
    );
    return { ok: true, transfer };
  } catch (error) {
    return {
      ok: false,
      kind: "server",
      message: extractSdpApiErrorMessage(error),
      status: error instanceof SdpApiResponseError ? error.status : null,
    };
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
