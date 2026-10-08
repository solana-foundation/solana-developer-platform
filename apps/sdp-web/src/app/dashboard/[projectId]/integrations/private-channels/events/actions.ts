"use server";

import type {
  PrivateChannelEventFamily,
  PrivateChannelEventListEnvelope,
  PrivateChannelEventStatus,
} from "@sdp/types";
import { fetchPrivateChannelEvents } from "@/lib/private-channels";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";

export type LoadEventsResult =
  | { ok: true; data: PrivateChannelEventListEnvelope }
  | { ok: false; message: string };

/**
 * Follow-up loads for the mounted Private Channels events feed.
 *
 * `projectId` is the page's immutable scope and is required: the request is
 * bound to it explicitly instead of re-reading the shared selection cookie,
 * so a cookie that switched projects between the page render and this action
 * can never answer with another project's events. A project the organization
 * no longer lists is refused, and the API still authorizes every response.
 */
export async function loadProjectEventsAction(input: {
  projectId: string;
  before?: string;
  limit?: number;
  family?: PrivateChannelEventFamily;
  status?: PrivateChannelEventStatus;
}): Promise<LoadEventsResult> {
  try {
    const client = await createProjectBoundSdpApiClient(input.projectId);
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
