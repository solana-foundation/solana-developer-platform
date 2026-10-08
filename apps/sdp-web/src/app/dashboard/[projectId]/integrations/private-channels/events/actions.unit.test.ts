import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  type PrivateChannelEventListEnvelope,
} from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProjectBoundSdpApiClient: vi.fn(),
  fetchPrivateChannelEvents: vi.fn(),
}));

vi.mock("@/lib/private-channels", () => ({
  fetchPrivateChannelEvents: mocks.fetchPrivateChannelEvents,
}));
vi.mock("@/lib/sdp-api", () => ({
  createProjectBoundSdpApiClient: mocks.createProjectBoundSdpApiClient,
}));

import { loadProjectEventsAction } from "./actions";

const envelope: PrivateChannelEventListEnvelope = {
  events: [],
  hasMore: false,
  nextCursor: null,
};

describe("loadProjectEventsAction", () => {
  const client = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectBoundSdpApiClient.mockResolvedValue(client);
  });

  it("binds the request to the requested project and forwards typed filters", async () => {
    mocks.fetchPrivateChannelEvents.mockResolvedValue(envelope);

    await expect(
      loadProjectEventsAction({
        projectId: "project_mounted",
        before: "cursor_1",
        limit: 25,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      })
    ).resolves.toEqual({ ok: true, data: envelope });

    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledWith("project_mounted");
    expect(mocks.fetchPrivateChannelEvents).toHaveBeenCalledWith(client, {
      before: "cursor_1",
      limit: 25,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
    });
  });

  it("returns a recoverable error result", async () => {
    mocks.fetchPrivateChannelEvents.mockRejectedValue(new Error("Gateway unavailable"));

    const result = await loadProjectEventsAction({ projectId: "project_mounted" });

    expect(result).toMatchObject({ ok: false });
  });

  it("fails closed when the requested project is not available for the organization", async () => {
    mocks.createProjectBoundSdpApiClient.mockRejectedValue(
      new Error("Requested project is not available for this organization")
    );

    const result = await loadProjectEventsAction({ projectId: "project_unlisted" });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.fetchPrivateChannelEvents).not.toHaveBeenCalled();
  });
});
