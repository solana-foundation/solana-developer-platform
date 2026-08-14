import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePrivateChannelsAccess: vi.fn(),
  createSdpApiClient: vi.fn(),
  invitePrivateChannelUser: vi.fn(),
  deletePrivateChannelUser: vi.fn(),
  addChannelMembership: vi.fn(),
  removeChannelMembership: vi.fn(),
}));

vi.mock("../private-channels-access", () => ({
  requirePrivateChannelsAccess: mocks.requirePrivateChannelsAccess,
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
  extractSdpApiErrorMessage: vi.fn(),
}));
vi.mock("@/lib/private-channels", () => ({
  invitePrivateChannelUser: mocks.invitePrivateChannelUser,
  deletePrivateChannelUser: mocks.deletePrivateChannelUser,
  addChannelMembership: mocks.addChannelMembership,
  removeChannelMembership: mocks.removeChannelMembership,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  addToChannelAction,
  deleteMemberAction,
  inviteMemberAction,
  removeFromChannelAction,
} from "./actions";

describe("private-channel member actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue({ fetch: vi.fn() });
  });

  it.each([
    ["invite", () => inviteMemberAction("usr_test")],
    ["delete", () => deleteMemberAction("pcu_test")],
    ["add", () => addToChannelAction("pch_test", "pcu_test")],
    ["remove", () => removeFromChannelAction("pch_test", "pcu_test")],
  ])("requires project-members:write before the %s mutation", async (_name, action) => {
    await action();

    expect(mocks.requirePrivateChannelsAccess).toHaveBeenCalledWith("project-members:write");
    expect(mocks.requirePrivateChannelsAccess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createSdpApiClient.mock.invocationCallOrder[0]
    );
  });
});
