// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceDashboardSearchParams } from "@/lib/dashboard-url-state";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation } from "@/test/window-location";
import { MembersSection } from "./members-section";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SETTINGS_URL = `/dashboard/${SANDBOX_PROJECT.id}/settings`;

function membersUrl(page: number): string {
  return `/api/dashboard/members?page=${page}&pageSize=25`;
}

function directory(name: string, role: string) {
  return {
    members: [
      {
        id: `mem_test_${role}`,
        role,
        status: "active",
        createdAt: "2026-10-01T00:00:00.000Z",
        isSelf: false,
        user: { id: "user_test_member", email: "member@example.test", name },
      },
    ],
    invitations: [],
    meta: { total: 1, page: 1, pageSize: 25, hasMore: false, activeAdminCount: 1 },
  };
}

function actionsFor(name: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name: `Actions for ${name}` });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreWindowLocation();
});

describe("MembersSection", () => {
  it.each([
    ["?tab=members", 1],
    ["?tab=members&membersPage=0", 1],
    ["?tab=members&membersPage=3", 3],
  ])("shows a skeleton, then the directory page %s names", async (query, page) => {
    window.history.replaceState(null, "", `${SETTINGS_URL}${query}`);
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, directory("Ada Lovelace", "member"))
    );

    const { container } = render(<MembersSection />, { wrapper: EnglishDashboardReads });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await actionsFor("Ada Lovelace")).toBeTruthy();
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: membersUrl(page), projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });

  it.each<[() => Response, string]>([
    [
      () => dashboardErrorResponse(503, "upstream unavailable"),
      "Members could not be loaded: upstream unavailable",
    ],
    [
      () => dashboardDataResponse(200, directory("Ada Lovelace", "owner")),
      "Members could not be loaded: the server did not answer as expected",
    ],
  ])(
    "keeps the invite form up when the directory fails (%#), and loads it on retry",
    async (failure, shown) => {
      window.history.replaceState(null, "", SETTINGS_URL);
      const fetchMock = stubDashboardFetch(() =>
        fetchMock.mock.calls.length === 1
          ? failure()
          : dashboardDataResponse(200, directory("Ada Lovelace", "member"))
      );
      const user = userEvent.setup();
      render(<MembersSection />, { wrapper: EnglishDashboardReads });

      expect((await screen.findByRole("alert")).textContent).toContain(shown);
      expect(screen.getByRole("button", { name: "Send invite" })).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(await actionsFor("Ada Lovelace")).toBeTruthy();
    }
  );

  it("keeps the page on show while the next one loads", async () => {
    window.history.replaceState(null, "", SETTINGS_URL);
    const secondPage = Promise.withResolvers<void>();
    stubDashboardFetch(async ({ path }) => {
      if (path === membersUrl(2)) {
        await secondPage.promise;
        return dashboardDataResponse(200, directory("Grace Hopper", "member"));
      }
      return dashboardDataResponse(200, directory("Ada Lovelace", "member"));
    });
    const { container } = render(<MembersSection />, { wrapper: EnglishDashboardReads });
    await actionsFor("Ada Lovelace");

    act(() => replaceDashboardSearchParams({ membersPage: "2" }));

    expect(screen.getByRole("button", { name: "Actions for Ada Lovelace" })).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    secondPage.resolve();
    expect(await actionsFor("Grace Hopper")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for Ada Lovelace" })).toBeNull();
  });
});
