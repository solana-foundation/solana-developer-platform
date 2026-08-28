"use server";

import type {
  PrivateChannelEventFamily,
  PrivateChannelEventListEnvelope,
  PrivateChannelEventStatus,
} from "@sdp/types";
import { fetchPrivateChannelEvents } from "@/lib/private-channels";
import { createSdpApiClient } from "@/lib/sdp-api";

export type LoadEventsResult =
  | { ok: true; data: PrivateChannelEventListEnvelope }
  | { ok: false; message: string };

export async function loadProjectEventsAction(input?: {
  before?: string;
  limit?: number;
  family?: PrivateChannelEventFamily;
  status?: PrivateChannelEventStatus;
}): Promise<LoadEventsResult> {
  try {
    const client = await createSdpApiClient();
    const data = await fetchPrivateChannelEvents(client, {
      before: input?.before,
      limit: input?.limit ?? 50,
      family: input?.family,
      status: input?.status,
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to load events.",
    };
  }
}
