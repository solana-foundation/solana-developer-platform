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

/**
 * Follow-up loads for the mounted Private Channels events feed.
 *
 * The request is bound to the Project in the tab's URL (the action posts to
 * it), never to the shared selection cookie, so a Project switched in another
 * tab can never answer with another project's events. The API still
 * authorizes every response.
 */
export async function loadProjectEventsAction(input: {
  before?: string;
  limit?: number;
  family?: PrivateChannelEventFamily;
  status?: PrivateChannelEventStatus;
}): Promise<LoadEventsResult> {
  try {
    const client = await createSdpApiClient();
    const data = await fetchPrivateChannelEvents(client, {
      before: input.before,
      limit: input.limit ?? 50,
      family: input.family,
      status: input.status,
    });
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Failed to load events.",
    };
  }
}
