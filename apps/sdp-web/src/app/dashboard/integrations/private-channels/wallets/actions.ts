"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import {
  deletePrivateChannelVerifiedWallet,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { bindRenderedProjectClient } from "../private-channels-project-client";

const PRIVATE_CHANNELS_PATH = "/dashboard/integrations/private-channels";

function revalidateWalletViews(): void {
  revalidatePath(PRIVATE_CHANNELS_PATH, "layout");
}

export type VerifyWalletResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | { ok: false; message: string };

export async function verifyWalletAction(input: {
  walletId: string;
  projectId: string;
  principalId?: string;
}): Promise<VerifyWalletResult> {
  const { walletId, projectId, principalId } = input;
  const t = await getTranslations();
  if (!walletId) {
    return { ok: false, message: t("DashboardPrivateChannels.verifiedWallets.walletRequired") };
  }
  try {
    const bound = await bindRenderedProjectClient(projectId);
    if (!bound.ok) {
      return bound;
    }
    const wallet = await verifyPrivateChannelWallet(bound.client, walletId, { principalId });
    revalidateWalletViews();
    return { ok: true, wallet };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteVerifiedWalletResult = { ok: true } | { ok: false; message: string };

export async function deleteVerifiedWalletAction(input: {
  pubkey: string;
  projectId: string;
}): Promise<DeleteVerifiedWalletResult> {
  try {
    const bound = await bindRenderedProjectClient(input.projectId);
    if (!bound.ok) {
      return bound;
    }
    await deletePrivateChannelVerifiedWallet(bound.client, input.pubkey);
    revalidateWalletViews();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
