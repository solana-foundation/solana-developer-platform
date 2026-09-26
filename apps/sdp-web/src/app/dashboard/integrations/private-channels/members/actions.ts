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
 * Whether a same-named active principal is one the lost first attempt could
 * have created — and only that. A retry flag attests a lost response but
 * cannot establish which principal, if any, the first attempt created, so
 * adoption must grant the submitted wallet nothing it could not get by
 * creating a fresh principal: a principal it created has no verified wallet
 * (only this action verifies one) and no channel memberships (only the
 * members table grants those). Established principals — the project default,
 * already wallet-verified, or already in channels — are never resumable.
 * Age is deliberately not a criterion: the wizard keeps the name locked
 * until this submission finishes, so the retry must resume the stranded
 * principal however much later the user makes it back, and an empty
 * principal grants the submitted wallet nothing a fresh creation would not.
 */
function isResumableLostResponsePrincipal(candidate: PrivateChannelPrincipalDto): boolean {
  return (
    !candidate.isDefault && candidate.verifiedWalletCount === 0 && candidate.channels.length === 0
  );
}

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export type CreateAndVerifyPrincipalResult =
  | { ok: true; wallet: PrivateChannelVerifiedWalletDto }
  | {
      ok: false;
      message: string;
      principalId?: string;
      /**
       * Same-named active principals the lost first attempt could have
       * created, newest first. Present while an attested retry waits for the
       * user to confirm the resume; nothing has been written yet.
       */
      resumeCandidates?: string[];
    };

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
 * response with `isRetry` and carries no id; the action then surfaces the
 * same-named active principal the first attempt could have created (with no
 * verified wallet and no channel memberships) as `resumeCandidates` and
 * writes nothing until the user confirms the resume with `resumePrincipalId`
 * — a retry flag cannot establish which principal, if any, the first attempt
 * created, so the user, not the flag, establishes it. A confirmed resume is
 * re-derived server-side, so a principal that became established between the
 * prompt and the confirmation is rejected rather than adopted. Anything else
 * same-named is reported as a name conflict, because adopting it would
 * attach the submitted wallet — and its verifications — to channel
 * memberships it was never meant to join. A fresh submission never adopts an
 * existing principal either and is never offered a resume: a same-named
 * active principal is reported as a name conflict.
 */
export async function createAndVerifyPrincipalAction(input: {
  name: string;
  walletId: string;
  projectId: string;
  /** Retry path: the id of a principal this wizard already created. */
  principalId?: string;
  /** Retry path: the previous attempt's response was lost, so no id is known. */
  isRetry?: boolean;
  /** Retry path: the user confirmed resuming this principal after a lost response. */
  resumePrincipalId?: string;
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
      const resumable = sameNamed.filter(isResumableLostResponsePrincipal);
      if (input.resumePrincipalId) {
        // The wizard attests that the user explicitly confirmed this
        // principal after the lost response — the retry flag alone never
        // could establish which principal, if any, the first attempt
        // created. The resumable list is re-derived server-side, so a
        // principal that became established between the prompt and the
        // confirmation is reported as a conflict rather than adopted.
        const confirmed = resumable.find((candidate) => candidate.id === input.resumePrincipalId);
        if (!confirmed) {
          return {
            ok: false,
            message: t("DashboardPrivateChannels.members.principalNameTaken"),
          };
        }
        principalId = confirmed.id;
      } else if (input.isRetry && resumable.length > 0) {
        // A retry flag attests a lost response but cannot establish which
        // principal, if any, the first attempt created, so the action never
        // adopts one silently: the candidate is surfaced and nothing is
        // written until the user confirms the resume.
        return {
          ok: false,
          message: t("DashboardPrivateChannels.members.resumePrompt", { name }),
          resumeCandidates: resumable.map((candidate) => candidate.id),
        };
      } else if (sameNamed.length > 0) {
        // A fresh submission must never adopt an existing principal, and a
        // same-named principal holding anything the first attempt could not
        // have created stays a conflict either way: verification would join
        // the submitted wallet to channel memberships this wizard did not
        // create.
        return {
          ok: false,
          message: t("DashboardPrivateChannels.members.principalNameTaken"),
        };
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
