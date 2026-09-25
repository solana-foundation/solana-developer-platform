"use server";

import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  fetchPrivateChannelPrincipals,
  removePrincipalChannelMembership,
  verifyPrivateChannelWallet,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
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
 * verification instead of creating a duplicate principal. If a response is
 * lost outright (the wizard never learns the id), a retry attests the lost
 * response with `isRetry` and carries no id; the action then resumes the
 * newest active principal with the submitted name instead of creating a
 * second one. A fresh submission never adopts an existing principal: a
 * same-named active principal is reported as a name conflict, because
 * adopting it would attach the submitted wallet — and its verifications —
 * to channel memberships it was never meant to join.
 */
export async function createAndVerifyPrincipalAction(input: {
  name: string;
  walletId: string;
  projectId: string;
  /** Retry path: the id of a principal this wizard already created. */
  principalId?: string;
  /** Retry path: the previous attempt's response was lost, so no id is known. */
  isRetry?: boolean;
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
    const name = input.name.trim();
    let principalId = input.principalId;
    if (!principalId) {
      const existing = (await fetchPrivateChannelPrincipals(bound.client))
        .filter((candidate) => candidate.status === "active" && candidate.name === name)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (existing && !input.isRetry) {
        // The wizard attests a lost response with isRetry; without it this is
        // a new submission, and a same-named principal must be reported as a
        // conflict rather than silently adopted: verification would join the
        // submitted wallet to the existing principal's channel memberships.
        return {
          ok: false,
          message: t("DashboardPrivateChannels.members.principalNameTaken"),
        };
      }
      if (existing) {
        // A previous attempt whose response was lost never delivered the
        // created id, so an attested retry re-enters without one. The wizard
        // submits the same trimmed name on every attempt; resuming the newest
        // active principal with that name keeps a lost response from
        // duplicating it.
        principalId = existing.id;
      } else {
        const { principal } = await createPrivateChannelPrincipal(bound.client, { name });
        principalId = principal.id;
        revalidatePath(PRINCIPALS_PATH);
      }
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
