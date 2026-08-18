"use server";

import type { PrivateChannelUserDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import {
  addChannelMembership as addChannelMembershipCall,
  deletePrivateChannelUser as deletePrivateChannelUserCall,
  invitePrivateChannelUser as inviteCall,
  removeChannelMembership as removeChannelMembershipCall,
} from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const MEMBERS_PATH = "/dashboard/payments/private-channels/members";

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; message: string };

export async function inviteMemberAction(
  userId: string
): Promise<ActionResult<{ user: PrivateChannelUserDto; inviteUrl: string }>> {
  try {
    const client = await createSdpApiClient();
    const value = await inviteCall(client, { userId });
    revalidatePath(MEMBERS_PATH);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function deleteMemberAction(id: string): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await deletePrivateChannelUserCall(client, id);
    revalidatePath(MEMBERS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function addToChannelAction(
  channelId: string,
  privateChannelUserId: string
): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await addChannelMembershipCall(client, channelId, privateChannelUserId);
    revalidatePath(MEMBERS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export async function removeFromChannelAction(
  channelId: string,
  privateChannelUserId: string
): Promise<ActionResult> {
  try {
    const client = await createSdpApiClient();
    await removeChannelMembershipCall(client, channelId, privateChannelUserId);
    revalidatePath(MEMBERS_PATH);
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
