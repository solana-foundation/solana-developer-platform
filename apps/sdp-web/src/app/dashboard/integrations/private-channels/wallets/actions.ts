"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import {
  deletePrivateChannelVerifiedWallet,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import {
  createProjectBoundSdpApiClient,
  extractSdpApiErrorMessage,
  getSelectedProjectId,
  type SdpApiClient,
} from "@/lib/sdp-api";

const PRIVATE_CHANNELS_PATH = "/dashboard/integrations/private-channels";

function revalidateWalletViews(): void {
  revalidatePath(PRIVATE_CHANNELS_PATH, "layout");
}

export type VerifyWalletResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | { ok: false; message: string };

const STALE_PROJECT_MESSAGE =
  "The selected project changed while this page was open. Reload the page and try again.";

type ProjectBoundClientResult = { ok: true; client: SdpApiClient } | { ok: false; message: string };

/**
 * Builds the mutation client from the project the page rendered with instead of
 * re-resolving the mutable selection cookie at submit time: a sibling tab that
 * moves `sdp_selected_project_id` between render and submit must never redirect
 * a wallet verification or revocation into another project's instance and
 * principal. The request's current selection is checked against the rendered
 * project first, so a stale page is told to reload rather than acting under a
 * scope it was never shown, and an unlisted project fails closed. The API still
 * authorizes membership on every request.
 */
async function bindRenderedProjectClient(projectId: string): Promise<ProjectBoundClientResult> {
  if (!projectId) {
    return { ok: false, message: "A project is required." };
  }
  const selectedProjectId = await getSelectedProjectId();
  if (selectedProjectId !== projectId) {
    return { ok: false, message: STALE_PROJECT_MESSAGE };
  }
  return { ok: true, client: await createProjectBoundSdpApiClient(projectId) };
}

export async function verifyWalletAction(input: {
  walletId: string;
  projectId: string;
  principalId?: string;
}): Promise<VerifyWalletResult> {
  const { walletId, projectId, principalId } = input;
  if (!walletId) {
    return { ok: false, message: "A wallet is required." };
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
