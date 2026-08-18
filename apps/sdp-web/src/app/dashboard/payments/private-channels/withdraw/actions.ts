"use server";

import type { PrivateChannelWithdrawal } from "@sdp/types";
import { revalidatePath } from "next/cache";
import type { MessageKey } from "@/i18n/messages";
import {
  createPrivateChannelWithdrawal,
  fetchPrivateChannelWithdrawal,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { getAmountError } from "../amount-validation";

export interface CreateWithdrawalInput {
  walletId: string;
  amount: string;
  /** Selected token mint; forwarded as-is for the API to validate. */
  mint?: string;
  destination?: string;
}

/**
 * Validation failures carry a `messageKey` for the client to translate; server
 * failures carry already-formatted text from the API, which has no key.
 */
export type CreateWithdrawalResult =
  | { ok: true; withdrawal: PrivateChannelWithdrawal }
  | { ok: false; kind: "validation"; messageKey: MessageKey }
  | { ok: false; kind: "server"; message: string };

export async function createWithdrawalAction(
  input: CreateWithdrawalInput
): Promise<CreateWithdrawalResult> {
  if (!input.walletId) {
    return {
      ok: false,
      kind: "validation",
      messageKey: "DashboardPrivateChannels.withdraw.selectWallet",
    };
  }
  const amountError = getAmountError(input.amount);
  if (amountError) {
    return { ok: false, kind: "validation", messageKey: amountError };
  }

  try {
    const client = await createSdpApiClient();
    const withdrawal = await createPrivateChannelWithdrawal(client, {
      walletId: input.walletId,
      amount: input.amount,
      ...(input.mint ? { mint: input.mint } : {}),
      ...(input.destination ? { destination: input.destination } : {}),
    });
    revalidatePath("/dashboard/payments/private-channels/withdraw");
    return { ok: true, withdrawal };
  } catch (error) {
    return { ok: false, kind: "server", message: extractSdpApiErrorMessage(error) };
  }
}

/** Poll target for the progress view. Returns null on transient failures. */
export async function fetchWithdrawalAction(id: string): Promise<PrivateChannelWithdrawal | null> {
  try {
    const client = await createSdpApiClient();
    return await fetchPrivateChannelWithdrawal(client, id);
  } catch {
    return null;
  }
}
