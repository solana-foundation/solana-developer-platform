"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import {
  deletePrivateChannelVerifiedWallet,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const WALLETS_PATH = "/dashboard/integrations/private-channels/wallets";
// The Overview's private-balance panel reflects verified-wallet balances too.
const OVERVIEW_PATH = "/dashboard/integrations/private-channels/overview";
const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

function revalidateWalletViews(): void {
  revalidatePath(WALLETS_PATH);
  revalidatePath(OVERVIEW_PATH);
  revalidatePath(PRINCIPALS_PATH);
}

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
    revalidateWalletViews();
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
    revalidateWalletViews();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
