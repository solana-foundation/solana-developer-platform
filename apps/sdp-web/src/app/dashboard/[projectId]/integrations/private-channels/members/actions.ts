"use server";

import type { PrivateChannelPrincipalDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { projectHref } from "@/lib/dashboard-project-path";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  removePrincipalChannelMembership,
} from "@/lib/private-channels";
import { createProjectBoundSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const PRINCIPALS_PATH = "/dashboard/integrations/private-channels/members";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export async function createPrincipalAction(
  projectId: string,
  name: string
): Promise<ActionResult<PrivateChannelPrincipalDto>> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    const { principal } = await createPrivateChannelPrincipal(client, { name });
    revalidatePath(projectHref(projectId, PRINCIPALS_PATH));
    return { ok: true, value: principal };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function disablePrincipalAction(projectId: string, id: string): Promise<ActionResult> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    await disablePrivateChannelPrincipal(client, id);
    revalidatePath(projectHref(projectId, PRINCIPALS_PATH));
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function addPrincipalToChannelAction(
  projectId: string,
  channelId: string,
  principalId: string
): Promise<ActionResult> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    await addPrincipalChannelMembership(client, channelId, principalId);
    revalidatePath(projectHref(projectId, PRINCIPALS_PATH));
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function removePrincipalFromChannelAction(
  projectId: string,
  channelId: string,
  principalId: string
): Promise<ActionResult> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    await removePrincipalChannelMembership(client, channelId, principalId);
    revalidatePath(projectHref(projectId, PRINCIPALS_PATH));
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
