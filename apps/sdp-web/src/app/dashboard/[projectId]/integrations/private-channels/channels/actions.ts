"use server";

import type { PrivateChannelDto } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { projectHref } from "@/lib/dashboard-project-path";
import { createPrivateChannel, deletePrivateChannel } from "@/lib/private-channels";
import { createProjectBoundSdpApiClient, extractSdpApiErrorMessage } from "@/lib/sdp-api";

const PRIVATE_CHANNELS_PATH = "/dashboard/integrations/private-channels";

export type CreateChannelResult =
  | { ok: true; channel: PrivateChannelDto }
  | { ok: false; message: string };

export async function createChannelAction(
  projectId: string,
  input: {
    name: string;
    description?: string;
  }
): Promise<CreateChannelResult> {
  const name = input.name?.trim();
  if (!name) {
    return { ok: false, message: "Channel name is required." };
  }

  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    const channel = await createPrivateChannel(client, {
      name,
      description: input.description?.trim() || undefined,
    });
    revalidatePath(projectHref(projectId, PRIVATE_CHANNELS_PATH), "layout");
    return { ok: true, channel };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}

export type DeleteChannelResult = { ok: true } | { ok: false; message: string };

export async function deleteChannelAction(
  projectId: string,
  id: string
): Promise<DeleteChannelResult> {
  try {
    const client = await createProjectBoundSdpApiClient(projectId);
    await deletePrivateChannel(client, id);
    revalidatePath(projectHref(projectId, PRIVATE_CHANNELS_PATH), "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: extractSdpApiErrorMessage(error) };
  }
}
