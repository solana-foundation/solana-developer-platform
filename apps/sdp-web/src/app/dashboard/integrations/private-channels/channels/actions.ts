"use server";

import type { PrivateChannelDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { createPrivateChannel, deletePrivateChannel } from "@/lib/private-channels";
import { createSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const CHANNELS_PATH = "/dashboard/integrations/private-channels/channels";

export type CreateChannelResult =
  | { ok: true; channel: PrivateChannelDto }
  | { ok: false; message: string };

export async function createChannelAction(input: {
  name: string;
  description?: string;
}): Promise<CreateChannelResult> {
  const name = input.name?.trim();
  if (!name) {
    return { ok: false, message: "Channel name is required." };
  }

  try {
    const client = await createSdpApiClient();
    const channel = await createPrivateChannel(client, {
      name,
      description: input.description?.trim() || undefined,
    });
    revalidatePath(CHANNELS_PATH);
    return { ok: true, channel };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteChannelResult = { ok: true } | { ok: false; message: string };

export async function deleteChannelAction(id: string): Promise<DeleteChannelResult> {
  try {
    const client = await createSdpApiClient();
    await deletePrivateChannel(client, id);
    revalidatePath(CHANNELS_PATH);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
