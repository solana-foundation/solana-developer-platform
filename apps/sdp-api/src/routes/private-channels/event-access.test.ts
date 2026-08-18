import { describe, expect, it, vi } from "vitest";
import type { ApiKeyContext } from "@/lib/auth";
import { resolveEventViewerForAuth } from "./event-access";

const PROJECT_ID = "prj_event_access";

const AUTH_BASE = {
  id: "usr_event_access",
  organizationId: "org_event_access",
  projectId: PROJECT_ID,
  role: "member",
  permissions: ["payments:read"],
  environment: "dashboard",
  signingWalletId: null,
  signingWalletIds: [],
  walletBindings: [],
} satisfies Partial<ApiKeyContext>;

function auth(
  overrides: Partial<Omit<ApiKeyContext, "authType" | "apiKeyId" | "userId">> = {}
): ApiKeyContext {
  return {
    ...AUTH_BASE,
    authType: "session",
    userId: "usr_event_access",
    apiKeyId: null,
    ...overrides,
  };
}

function apiKeyAuth(
  overrides: Partial<Omit<ApiKeyContext, "authType" | "apiKeyId" | "userId">> = {}
): ApiKeyContext {
  return {
    ...AUTH_BASE,
    authType: "api_key",
    userId: null,
    apiKeyId: "key_event_access",
    ...overrides,
  };
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

    const viewer = await resolveEventViewerForAuth(apiKeyAuth(), PROJECT_ID, deps);

    expect(viewer).toEqual({ scope: "all" });
    expect(deps.findPrivateChannelUser).not.toHaveBeenCalled();
  });

  it("rejects API keys whose project does not match the requested project", async () => {
    const deps = dependencies();

    await expect(
      resolveEventViewerForAuth(apiKeyAuth({ projectId: "prj_other" }), PROJECT_ID, deps)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(deps.findPrivateChannelUser).not.toHaveBeenCalled();
  });

  it("gives project writers full event visibility", async () => {
    const deps = dependencies();

    const viewer = await resolveEventViewerForAuth(
      auth({ permissions: ["payments:read", "projects:write"] }),
      PROJECT_ID,
      deps
    );

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

    const viewer = await resolveEventViewerForAuth(auth(), PROJECT_ID, deps);

    expect(viewer).toEqual({
      scope: "member",
      channelIds: ["pch_alpha", "pch_beta"],
      userId: "usr_event_access",
    });
    expect(deps.findPrivateChannelUser).toHaveBeenCalledWith(
      { organizationId: "org_event_access", projectId: PROJECT_ID },
      "usr_event_access"
    );
    expect(deps.listMemberships).toHaveBeenCalledWith("pcu_event_access");
  });

  it("preserves authored-transfer visibility after Private Channels membership removal", async () => {
    const deps = dependencies();
    deps.findPrivateChannelUser.mockResolvedValue(null);

    const viewer = await resolveEventViewerForAuth(auth(), PROJECT_ID, deps);

    expect(viewer).toEqual({
      scope: "member",
      channelIds: [],
      userId: "usr_event_access",
    });
    expect(deps.listMemberships).not.toHaveBeenCalled();
  });

  it("keeps authored-transfer visibility when the member has no channel memberships", async () => {
    const deps = dependencies();
    deps.findPrivateChannelUser.mockResolvedValue({ id: "pcu_event_access" });
    deps.listMemberships.mockResolvedValue([]);

    const viewer = await resolveEventViewerForAuth(auth(), PROJECT_ID, deps);

    expect(viewer).toEqual({
      scope: "member",
      channelIds: [],
      userId: "usr_event_access",
    });
  });
});
