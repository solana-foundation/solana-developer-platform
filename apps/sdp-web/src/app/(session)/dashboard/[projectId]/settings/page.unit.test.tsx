import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import SettingsPage from "./page";
import { SettingsWorkspace } from "./settings-workspace";

describe("settings page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the settings workspace for an active organization", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });

    expect((await SettingsPage()).type).toBe(SettingsWorkspace);
  });

  it("sends a session without an active organization to the dashboard", async () => {
    mocks.auth.mockResolvedValue({ userId: "user_test", orgId: null });

    await expect(SettingsPage()).rejects.toThrow("NEXT_REDIRECT /dashboard");
  });
});
