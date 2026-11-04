// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { AccountSecurity } from "./account-security";

function testSession(id: string, status: "active" | "revoked", browserName: string) {
  return {
    id,
    status,
    lastActiveAt: new Date("2026-11-01T10:00:00.000Z"),
    latestActivity: {
      browserName,
      browserVersion: "1",
      deviceType: "Macintosh",
      city: "Lisbon",
      country: "PT",
      ipAddress: "192.0.2.1",
    },
    revoke: vi.fn(),
  };
}

type TestSession = ReturnType<typeof testSession>;

function testUser(passwordEnabled: boolean, sessions: TestSession[]) {
  return {
    id: "user_test_jane",
    passwordEnabled,
    updatePassword: vi.fn(),
    getSessions: vi.fn().mockResolvedValue(sessions),
  };
}

const clerk = vi.hoisted(() => {
  const state: { user: ReturnType<typeof testUser> | null; currentSessionId: string } = {
    user: null,
    currentSessionId: "sess_test_current",
  };
  return state;
});

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: clerk.user }),
  useSession: () => ({ session: { id: clerk.currentSessionId } }),
  useReverification: (action: unknown) => action,
}));

function Providers({ children }: { children: ReactNode }) {
  return (
    <EnglishI18n>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </EnglishI18n>
  );
}

function renderSecurity(user: ReturnType<typeof testUser>) {
  clerk.user = user;
  return render(<AccountSecurity />, { wrapper: Providers });
}

afterEach(() => {
  cleanup();
});

describe("AccountSecurity password", () => {
  it("sends the current password when one is set and signs out the other sessions", async () => {
    const user = testUser(true, []);
    user.updatePassword.mockResolvedValue(user);
    renderSecurity(user);
    const actor = userEvent.setup();

    await actor.click(screen.getByRole("button", { name: "Change password" }));
    await actor.type(screen.getByLabelText("Current password"), "old-password-test");
    await actor.type(screen.getByLabelText("New password"), "new-password-test");
    await actor.click(screen.getByRole("button", { name: "Save" }));

    expect(user.updatePassword).toHaveBeenCalledExactlyOnceWith({
      newPassword: "new-password-test",
      currentPassword: "old-password-test",
      signOutOfOtherSessions: true,
    });
    await waitFor(() => expect(screen.queryByLabelText("New password")).toBeNull());
  });

  it("sets a first password without asking for a current one", async () => {
    const user = testUser(false, []);
    user.updatePassword.mockResolvedValue(user);
    renderSecurity(user);
    const actor = userEvent.setup();

    await actor.click(screen.getByRole("button", { name: "Set password" }));
    expect(screen.queryByLabelText("Current password")).toBeNull();
    await actor.type(screen.getByLabelText("New password"), "new-password-test");
    await actor.click(screen.getByRole("button", { name: "Save" }));

    expect(user.updatePassword).toHaveBeenCalledExactlyOnceWith({
      newPassword: "new-password-test",
      currentPassword: undefined,
      signOutOfOtherSessions: true,
    });
    await waitFor(() => expect(screen.queryByLabelText("New password")).toBeNull());
  });

  it("reloads the sessions after a save so the signed-out ones drop off", async () => {
    const current = testSession(clerk.currentSessionId, "active", "Chrome");
    const other = testSession("sess_test_other", "active", "Firefox");
    const user = testUser(true, [current, other]);
    user.updatePassword.mockResolvedValue(user);
    renderSecurity(user);
    const actor = userEvent.setup();
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);

    user.getSessions.mockResolvedValue([current]);
    await actor.click(screen.getByRole("button", { name: "Change password" }));
    await actor.type(screen.getByLabelText("Current password"), "old-password-test");
    await actor.type(screen.getByLabelText("New password"), "new-password-test");
    await actor.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.queryByText("Firefox 1 · Macintosh")).toBeNull();
    expect(other.revoke).not.toHaveBeenCalled();
  });
});

describe("AccountSecurity sessions", () => {
  it("lists live sessions with this device first and signs another one out", async () => {
    const other = testSession("sess_test_other", "active", "Firefox");
    const current = testSession(clerk.currentSessionId, "active", "Chrome");
    const revoked = testSession("sess_test_revoked", "revoked", "Safari");
    other.revoke.mockResolvedValue(other);
    const user = testUser(true, [other, current, revoked]);
    renderSecurity(user);
    const actor = userEvent.setup();

    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const [currentRow, otherRow] = rows;
    expect(within(currentRow).getByText("Chrome 1 · Macintosh")).toBeDefined();
    expect(within(currentRow).getByText("This device")).toBeDefined();
    expect(within(currentRow).queryByRole("button")).toBeNull();
    expect(within(otherRow).getByText("Firefox 1 · Macintosh")).toBeDefined();
    expect(within(otherRow).queryByText("This device")).toBeNull();
    expect(screen.queryByText(/Safari/)).toBeNull();

    user.getSessions.mockResolvedValue([current]);
    await actor.click(within(otherRow).getByRole("button", { name: "Sign out" }));

    expect(other.revoke).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });
});
