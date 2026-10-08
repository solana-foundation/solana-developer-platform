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

  it("loads through the request's Project client and forwards typed filters", async () => {
    mocks.fetchPrivateChannelEvents.mockResolvedValue(envelope);

    await expect(
      loadProjectEventsAction({
        before: "cursor_1",
        limit: 25,
        family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
        status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
      })
    ).resolves.toEqual({ ok: true, data: envelope });

    expect(mocks.createSdpApiClient).toHaveBeenCalledWith();
    expect(mocks.fetchPrivateChannelEvents).toHaveBeenCalledWith(client, {
      before: "cursor_1",
      limit: 25,
      family: PRIVATE_CHANNEL_EVENT_FAMILIES.TRANSFER,
      status: PRIVATE_CHANNEL_EVENT_STATUSES.FAILED,
    });
  });

  it.each([
    ["the events request", mocks.fetchPrivateChannelEvents],
    ["the client", mocks.createSdpApiClient],
  ])("returns a recoverable error result when %s fails", async (_, failing) => {
    failing.mockRejectedValue(new Error("Gateway unavailable"));

    await expect(loadProjectEventsAction({})).resolves.toEqual({
      ok: false,
      message: "Gateway unavailable",
    });
  });
});
