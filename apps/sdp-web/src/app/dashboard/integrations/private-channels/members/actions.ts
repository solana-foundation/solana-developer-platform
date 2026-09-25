"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  removePrincipalChannelMembership,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { getTranslations } from "@/i18n/server";
import { bindRenderedProjectClient } from "../private-channels-project-client";

const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export type CreateAndVerifyPrincipalResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | { ok: false; message: string; principalId?: string };

/**
 * Creates the principal and verifies its wallet in one server action, so one
 * stale-selection check runs before either write and both writes go through
 * the same project-bound client. Splitting this into two actions would give a
 * sibling tab that moves the shared cookie between the two submissions a
 * window to reject the verification after the principal was already created,
 * stranding it unverified once the wizard reloads. On a verification failure
 * after creation the created id is returned so a retry re-runs only the
 * verification instead of creating a duplicate principal.
 */
export async function createAndVerifyPrincipalAction(input: {
  name: string;
  walletId: string;
  projectId: string;
  /** Retry path: the id of a principal this wizard already created. */
  principalId?: string;
}): Promise<CreateAndVerifyPrincipalResult> {
  const t = await getTranslations();
  if (!input.walletId) {
    return { ok: false, message: t("DashboardPrivateChannels.verifiedWallets.walletRequired") };
  }
  try {
    const bound = await bindRenderedProjectClient(input.projectId);
    if (!bound.ok) {
      return bound;
    }
    let principalId = input.principalId;
    if (!principalId) {
      const { principal } = await createPrivateChannelPrincipal(bound.client, {
        name: input.name,
      });
      principalId = principal.id;
      revalidatePath(PRINCIPALS_PATH);
    }
    try {
      const wallet = await verifyPrivateChannelWallet(bound.client, input.walletId, {
        principalId,
      });
      revalidatePath(PRINCIPALS_PATH);
      return { ok: true, wallet };
    } catch (error) {
      return { ok: false, message: extractSdpApiErrorMessage(error), principalId };
    }
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function disablePrincipalAction(id: string): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await disablePrivateChannelPrincipal(client, id);
    revalidatePath(PRINCIPALS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function addPrincipalToChannelAction(
  channelId: string,
  principalId: string
): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await addPrincipalChannelMembership(client, channelId, principalId);
    revalidatePath(PRINCIPALS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function removePrincipalFromChannelAction(
  channelId: string,
  principalId: string
): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await removePrincipalChannelMembership(client, channelId, principalId);
    revalidatePath(PRINCIPALS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
