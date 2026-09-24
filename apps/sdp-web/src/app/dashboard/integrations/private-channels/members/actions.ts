"use server";

import type { PrivateChannelPrincipalDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  removePrincipalChannelMembership,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";
import { bindRenderedProjectClient } from "../private-channels-project-client";

const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Creates the principal under the project the wizard rendered with instead of
 * re-resolving the mutable selection cookie at submit time. The stale-selection
 * check runs before the write, so a sibling tab that moved the shared cookie
 * makes the submission reload instead of leaving a principal stranded in
 * another project's scope before its wallet verification can bind to it.
 */
export async function createPrincipalAction(input: {
  name: string;
  projectId: string;
}): Promise<ActionResult<PrivateChannelPrincipalDto>> {
  try {
    const bound = await bindRenderedProjectClient(input.projectId);
    if (!bound.ok) {
      return bound;
    }
    const { principal } = await createPrivateChannelPrincipal(bound.client, { name: input.name });
    revalidatePath(PRINCIPALS_PATH);
    return { ok: true, value: principal };
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
