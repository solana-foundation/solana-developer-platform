"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types/private-channels";
import {
  deletePrivateChannelVerifiedWallet,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

export type VerifyWalletResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | { ok: false; message: string };

export async function verifyWalletAction(
  walletId: string,
  principalId?: string
): Promise<VerifyWalletResult> {
  if (!walletId) {
    return { ok: false, message: "A wallet is required." };
  }
  try {
    const client = await createSdpApiClient();
    const wallet = await verifyPrivateChannelWallet(client, walletId, { principalId });
    return { ok: true, wallet };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteVerifiedWalletResult = { ok: true } | { ok: false; message: string };

export async function deleteVerifiedWalletAction(
  pubkey: string
): Promise<DeleteVerifiedWalletResult> {
  try {
    const client = await createSdpApiClient();
    await deletePrivateChannelVerifiedWallet(client, pubkey);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
