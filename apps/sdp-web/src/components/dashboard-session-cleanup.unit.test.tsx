// @vitest-environment jsdom

import * as clerkSdk from "@clerk/nextjs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardSessionCleanup } from "./dashboard-session-cleanup";

const clerk: { auth: { isLoaded: boolean; sessionId: string | null } } = {
  auth: { isLoaded: true, sessionId: "session_a" },
};

beforeEach(() => {
  vi.mocked(vi.spyOn(clerkSdk, "useAuth"), { partial: true }).mockImplementation(() => clerk.auth);
  clerk.auth = { isLoaded: true, sessionId: "session_a" };
  for (const storage of [localStorage, sessionStorage]) {
    storage.setItem("sdp.dashboard.cache.user:org:project.wallets", "private data");
    storage.setItem("sdp-theme", "dark");
    storage.setItem(
      "sdp:dashboard:mutation:idempotency:v1:user:org",
      "pending payment recovery key"
    );
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("dashboard session cleanup", () => {
  it.each([null, "session_b"])("purges snapshots when the session becomes %s", (sessionId) => {
    const view = render(<DashboardSessionCleanup />);
    clerk.auth = { isLoaded: true, sessionId };
    view.rerender(<DashboardSessionCleanup />);
    for (const storage of [localStorage, sessionStorage]) {
      expect(storage.getItem("sdp.dashboard.cache.user:org:project.wallets")).toBeNull();
      expect(storage.getItem("sdp-theme")).toBe("dark");
      expect(storage.getItem("sdp:dashboard:mutation:idempotency:v1:user:org")).toBe(
        "pending payment recovery key"
      );
    }
  });

  it("purges persisted data when a signed-out browser mounts", () => {
    clerk.auth = { isLoaded: true, sessionId: null };
    render(<DashboardSessionCleanup />);
    expect(localStorage.getItem("sdp.dashboard.cache.user:org:project.wallets")).toBeNull();
  });

  it("keeps the active session cache while Clerk is loading", () => {
    clerk.auth = { isLoaded: false, sessionId: null };
    render(<DashboardSessionCleanup />);
    expect(localStorage.getItem("sdp.dashboard.cache.user:org:project.wallets")).toBe(
      "private data"
    );
  });

  it("still clears session snapshots when access to local storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    clerk.auth = { isLoaded: true, sessionId: null };
    expect(() => render(<DashboardSessionCleanup />)).not.toThrow();
    expect(sessionStorage.getItem("sdp.dashboard.cache.user:org:project.wallets")).toBeNull();
  });
});
