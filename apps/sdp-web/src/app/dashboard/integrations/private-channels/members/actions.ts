"use server";

import type { PrivateChannelPrincipalDto, PrivateChannelVerifiedWalletDto } from "@sdp/types";
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

/**
 * How long a lost-response retry may resume a principal the first attempt
 * could have created. The wizard locks the name and offers the retry
 * immediately, so a same-named principal older than this window predates the
 * submission.
 */
const RESUME_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether a same-named active principal is one the lost first attempt could
 * have created — and only that. A retry flag attests a lost response but
 * cannot establish which principal, if any, the first attempt created, so
 * adoption must grant the submitted wallet nothing it could not get by
 * creating a fresh principal: the first attempt reaches this action alone, so
 * a principal it created has no verified wallet (only this action verifies
 * one) and no channel memberships (only the members table grants those).
 * Established principals — the project default, older than the window,
 * already wallet-verified, or already in channels — are never resumable.
 */
function isResumableLostResponsePrincipal(candidate: PrivateChannelPrincipalDto): boolean {
  if (candidate.isDefault || candidate.verifiedWalletCount !== 0 || candidate.channels.length > 0) {
    return false;
  }
  const createdAt = Date.parse(candidate.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt <= RESUME_WINDOW_MS;
}

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
 * newest same-named active principal the first attempt could have created
 * (recent, with no verified wallet and no channel memberships) instead of
 * creating a second one. Anything else same-named is reported as a name
 * conflict: a retry flag cannot establish which principal, if any, the first
 * attempt created, so adoption is limited to a principal holding nothing the
 * submitted wallet could not get by creating a fresh one. A fresh submission
 * never adopts an existing principal either: a same-named active principal is
 * reported as a name conflict, because adopting it would attach the submitted
 * wallet — and its verifications — to channel memberships it was never meant
 * to join.
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
      const sameNamed = (await fetchPrivateChannelPrincipals(bound.client))
        .filter((candidate) => candidate.status === "active" && candidate.name === name)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const resumable = input.isRetry
        ? sameNamed.find(isResumableLostResponsePrincipal)
        : undefined;
      if (sameNamed.length > 0 && !resumable) {
        // A fresh submission must never adopt an existing principal, and a
        // retry flag alone cannot establish that the first attempt created
        // one: either way a same-named principal with no resumable candidate
        // is reported as a conflict rather than adopted, so verification can
        // never join the submitted wallet to a principal's channel
        // memberships this wizard did not create.
        return {
          ok: false,
          message: t("DashboardPrivateChannels.members.principalNameTaken"),
        };
      }
      if (resumable) {
        // A previous attempt whose response was lost never delivered the
        // created id, so an attested retry re-enters without one. The wizard
        // submits the same trimmed name on every attempt; resuming the newest
        // principal the first attempt could have created (see
        // isResumableLostResponsePrincipal) keeps a lost response from
        // duplicating it without ever adopting an established one.
        principalId = resumable.id;
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
