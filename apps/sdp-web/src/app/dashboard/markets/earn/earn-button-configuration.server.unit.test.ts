import type { EarnButtonConfiguration } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
  SdpApiResponseError: class SdpApiResponseError extends Error {
    constructor(
      readonly status: number,
      readonly responseBody: string
    ) {
      super(`SDP API request failed (${status}): ${responseBody}`);
    }
  },
}));

import { loadEarnButtonConfiguration } from "./earn-button-configuration.server";

const configuration: EarnButtonConfiguration = {
  id: "earn_button_configuration_test",
  strategyId: "earn_strategy_test",
  style: "accent",
  accentColor: "#9945FF",
  publicToken: "abcdefghijklmnopqrstuvwx",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("loadEarnButtonConfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the API client's already-unwrapped response", async () => {
    const fetch = vi.fn().mockResolvedValue({ configuration });
    mocks.createSdpApiClient.mockResolvedValue({ fetch });

    await expect(loadEarnButtonConfiguration()).resolves.toEqual({
      kind: "ready",
      configuration,
    });
    expect(fetch).toHaveBeenCalledWith("/v1/earn/button-configurations/current");
  });

  it("treats a missing saved configuration as an empty ready state", async () => {
    const { SdpApiResponseError } = await import("@/lib/sdp-api");
    mocks.createSdpApiClient.mockResolvedValue({
      fetch: vi.fn().mockRejectedValue(new SdpApiResponseError(404, "not found")),
    });

    await expect(loadEarnButtonConfiguration()).resolves.toEqual({
      kind: "ready",
      configuration: null,
    });
  });
});
