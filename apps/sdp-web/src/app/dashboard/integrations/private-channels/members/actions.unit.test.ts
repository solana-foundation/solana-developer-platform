import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePrivateChannelsAccess: vi.fn(),
  createSdpApiClient: vi.fn(),
  createPrivateChannelPrincipal: vi.fn(),
  disablePrivateChannelPrincipal: vi.fn(),
  addPrincipalChannelMembership: vi.fn(),
  removePrincipalChannelMembership: vi.fn(),
}));

vi.mock("../private-channels-access", () => ({
  requirePrivateChannelsAccess: mocks.requirePrivateChannelsAccess,
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
  extractSdpApiErrorMessage: vi.fn(),
}));
vi.mock("@/lib/private-channels", () => ({
  createPrivateChannelPrincipal: mocks.createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal: mocks.disablePrivateChannelPrincipal,
  addPrincipalChannelMembership: mocks.addPrincipalChannelMembership,
  removePrincipalChannelMembership: mocks.removePrincipalChannelMembership,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  addPrincipalToChannelAction,
  createPrincipalAction,
  disablePrincipalAction,
  removePrincipalFromChannelAction,
} from "./actions";

describe("private-channel principal actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue({ fetch: vi.fn() });
    mocks.createPrivateChannelPrincipal.mockResolvedValue({ principal: {} });
  });

  it.each([
    ["create", () => createPrincipalAction("Treasury")],
    ["disable", () => disablePrincipalAction("pcp_test")],
    ["add", () => addPrincipalToChannelAction("pch_test", "pcp_test")],
    ["remove", () => removePrincipalFromChannelAction("pch_test", "pcp_test")],
  ])("requires project-members:write before the %s mutation", async (_name, action) => {
    await action();

    expect(mocks.requirePrivateChannelsAccess).toHaveBeenCalledWith("project-members:write");
    expect(mocks.requirePrivateChannelsAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createSdpApiClient.mock.invocationCallOrder[0]
    );
  });
});
