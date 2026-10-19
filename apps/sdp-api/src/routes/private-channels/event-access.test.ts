import type { OrganizationRole } from "@sdp/types/roles";
import { describe, expect, it, vi } from "vitest";
import { type ApiKeyContext, authMayPerform } from "@/lib/auth";
import { resolveEventViewerForAuth } from "./event-access";

const PROJECT_ID = "prj_event_access";

const AUTH_BASE = {
  id: "usr_test_event_access",
  organizationId: "org_test_event_access",
  projectId: PROJECT_ID,
  environment: "dashboard",
  walletAccess: { scope: "all" } as const,
} satisfies Partial<ApiKeyContext>;

function auth(role: OrganizationRole = "member"): ApiKeyContext {
  return {
    ...AUTH_BASE,
    authType: "clerk",
    userId: "usr_test_event_access",
    apiKeyId: null,
    grants: null,
    role,
  };
}

function apiKeyAuth(overrides: { projectId?: string } = {}): ApiKeyContext {
  return {
    ...AUTH_BASE,
    authType: "api_key",
    userId: null,
    apiKeyId: "key_event_access",
    grants: ["private_channels.read"],
    role: null,
    ...overrides,
  };
}

/** The viewer for a caller, deciding projects.manage as callerMayPerform would. */
function viewerFor(caller: ApiKeyContext, deps: ReturnType<typeof dependencies>) {
  return resolveEventViewerForAuth(
    caller,
    PROJECT_ID,
    deps,
    authMayPerform(caller, "projects.manage")
  );
}

function dependencies() {
  return {
    findPrivateChannelUser: vi.fn(),
    listMemberships: vi.fn(),
  };
}

describe("resolveEventViewerForAuth", () => {
  it("gives API keys full event visibility", async () => {
    const deps = dependencies();
    const viewer = await viewerFor(apiKeyAuth({}), deps);
    expect(viewer).toEqual({ scope: "all" });
    expect(deps.findPrivateChannelUser).not.toHaveBeenCalled();
  });
  it("rejects API keys whose project does not match the requested project", async () => {
    const deps = dependencies();
    await expect(viewerFor(apiKeyAuth({ projectId: "prj_other" }), deps)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(deps.findPrivateChannelUser).not.toHaveBeenCalled();
  });
  it("gives project administrators full event visibility", async () => {
    const deps = dependencies();
    const viewer = await viewerFor(auth("admin"), deps);
    expect(viewer).toEqual({ scope: "all" });
    expect(deps.findPrivateChannelUser).not.toHaveBeenCalled();
  });
  it("limits ordinary members to their channel memberships and authored transfers", async () => {
    const deps = dependencies();
    deps.findPrivateChannelUser.mockResolvedValue({ id: "pcu_event_access" });
    deps.listMemberships.mockResolvedValue([
      { channel_id: "pch_alpha" },
      { channel_id: "pch_beta" },
    ]);
    const viewer = await viewerFor(auth(), deps);
    expect(viewer).toEqual({
      scope: "member",
      channelIds: ["pch_alpha", "pch_beta"],
      userId: "usr_test_event_access",
    });
    expect(deps.findPrivateChannelUser).toHaveBeenCalledWith(
      { organizationId: "org_test_event_access", projectId: PROJECT_ID },
      "usr_test_event_access"
    );
    expect(deps.listMemberships).toHaveBeenCalledWith("pcu_event_access");
  });
  it("preserves authored-transfer visibility after Private Channels membership removal", async () => {
    const deps = dependencies();
    deps.findPrivateChannelUser.mockResolvedValue(null);
    const viewer = await viewerFor(auth(), deps);
    expect(viewer).toEqual({
      scope: "member",
      channelIds: [],
      userId: "usr_test_event_access",
    });
    expect(deps.listMemberships).not.toHaveBeenCalled();
  });
  it("keeps authored-transfer visibility when the member has no channel memberships", async () => {
    const deps = dependencies();
    deps.findPrivateChannelUser.mockResolvedValue({ id: "pcu_event_access" });
    deps.listMemberships.mockResolvedValue([]);
    const viewer = await viewerFor(auth(), deps);
    expect(viewer).toEqual({
      scope: "member",
      channelIds: [],
      userId: "usr_test_event_access",
    });
  });
});
