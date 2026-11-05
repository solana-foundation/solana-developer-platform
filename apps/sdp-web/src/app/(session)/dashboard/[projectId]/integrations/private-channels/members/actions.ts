"use server";

import type { PrivateChannelPrincipalDto } from "@sdp/types/private-channels";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  removePrincipalChannelMembership,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export async function createPrincipalAction(
  name: string
): Promise<ActionResult<PrivateChannelPrincipalDto>> {
  try {
    const client = await createSdpApiClient();
    const { principal } = await createPrivateChannelPrincipal(client, { name });
    return { ok: true, value: principal };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function disablePrincipalAction(id: string): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await disablePrivateChannelPrincipal(client, id);
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
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
