"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  deletePrivateChannelVerifiedWallet,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { createProjectBoundSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const PRIVATE_CHANNELS_PATH = "/dashboard/integrations/private-channels";

function revalidateWalletViews(projectId: string): void {
  revalidatePath(projectHref(projectId, PRIVATE_CHANNELS_PATH), "layout");
}

export type VerifyWalletResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | { ok: false; message: string };

export async function verifyWalletAction(
  projectId: string,
  walletId: string,
  principalId?: string
): Promise<VerifyWalletResult> {
  if (!walletId) {
    return { ok: false, message: "A wallet is required." };
  }
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    const wallet = await verifyPrivateChannelWallet(client, walletId, { principalId });
    revalidateWalletViews(projectId);
    return { ok: true, wallet };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteVerifiedWalletResult = { ok: true } | { ok: false; message: string };

export async function deleteVerifiedWalletAction(
  projectId: string,
  pubkey: string
): Promise<DeleteVerifiedWalletResult> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    await deletePrivateChannelVerifiedWallet(client, pubkey);
    revalidateWalletViews(projectId);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
