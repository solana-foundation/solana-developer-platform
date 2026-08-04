"use server";

import type { PrivateChannelDeposit } from "@sdp/types";
import { revalidatePath } from "next/cache";
import type { MessageKey } from "@/i18n/messages";
import { createPrivateChannelDeposit, fetchPrivateChannelDeposit } from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { getAmountError } from "../amount-validation";

export interface CreateDepositInput {
  walletId: string;
  amount: string;
  /**
   * Selected token mint. Forwarded as-is: the API validates it against the
   * instance's allowlist, so this action must not vouch for it — nor read a scale
   * from it, since a client-supplied decimals value cannot be trusted.
   */
  mint?: string;
  recipient?: string;
}

/**
 * Validation failures carry a `messageKey` for the client to translate; server
 * failures carry already-formatted text from the API, which has no key.
 */
export type CreateDepositResult =
  | { ok: true; deposit: PrivateChannelDeposit }
  | { ok: false; kind: "validation"; messageKey: MessageKey }
  | { ok: false; kind: "server"; message: string };

export async function createDepositAction(input: CreateDepositInput): Promise<CreateDepositResult> {
  if (!input.walletId) {
    return {
      ok: false,
      kind: "validation",
      messageKey: "DashboardPrivateChannels.deposit.selectWallet",
    };
  }
  const amountError = getAmountError(input.amount);
  if (amountError) {
    return { ok: false, kind: "validation", messageKey: amountError };
  }

  try {
    const client = await createSdpApiClient();
    const deposit = await createPrivateChannelDeposit(client, {
      walletId: input.walletId,
      amount: input.amount,
      ...(input.mint ? { mint: input.mint } : {}),
      ...(input.recipient ? { recipient: input.recipient } : {}),
    });
    revalidatePath("/dashboard/payments/private-channels/deposit");
    return { ok: true, deposit };
  } catch (error) {
    return { ok: false, kind: "server", message: extractSdpApiErrorMessage(error) };
  }
}

/** Poll target for the progress view. Returns null on transient failures. */
export async function fetchDepositAction(id: string): Promise<PrivateChannelDeposit | null> {
  try {
    const client = await createSdpApiClient();
    return await fetchPrivateChannelDeposit(client, id);
  } catch {
    return null;
  }
}
