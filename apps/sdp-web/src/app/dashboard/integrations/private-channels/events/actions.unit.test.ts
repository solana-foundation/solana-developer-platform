import {
  PRIVATE_CHANNEL_EVENT_FAMILIES,
  PRIVATE_CHANNEL_EVENT_STATUSES,
  type PrivateChannelEventListEnvelope,
} from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  fetchPrivateChannelEvents: vi.fn(),
}));

vi.mock("@/lib/private-channels", () => ({
  fetchPrivateChannelEvents: mocks.fetchPrivateChannelEvents,
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
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
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("forwards typed family, status, and cursor filters", async () => {
    mocks.fetchPrivateChannelEvents.mockResolvedValue(envelope);

    await expect(
      loadProjectEventsAction({
        before: "cursor_1",
        limit: 25,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      })
    ).resolves.toEqual({ ok: true, data: envelope });

    expect(mocks.fetchPrivateChannelEvents).toHaveBeenCalledWith(client, {
      before: "cursor_1",
      limit: 25,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
    });
  });

  it("returns a recoverable error result", async () => {
    mocks.fetchPrivateChannelEvents.mockRejectedValue(new Error("Gateway unavailable"));

    const result = await loadProjectEventsAction();

    expect(result).toMatchObject({ ok: false });
  });
});
