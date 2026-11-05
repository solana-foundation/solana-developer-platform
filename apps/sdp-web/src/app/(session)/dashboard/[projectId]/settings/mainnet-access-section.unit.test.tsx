// @vitest-environment jsdom
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  readsOf,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishDashboardReads } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { MainnetAccessSection } from "./mainnet-access-section";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const CURRENT_ORGANIZATION_URL = "/api/dashboard/organizations/current";
const MAINNET_ACCESS_URL = "/api/dashboard/organizations/org_test%2F1/mainnet-access";
const APPROVED: MainnetAccess = {
  state: "approved",
  available: true,
  countryCode: null,
  request: {
    requestedAt: "2026-11-01T12:00:00.000Z",
    requestedByUserId: "user_test_admin",
    termsVersion: "2026-10",
    notified: true,
  },
  contactEmail: "mainnet@example.test",
};

function renderSection(access: MainnetAccess, failingOnce: string | null) {
  const fetchMock = stubDashboardFetch(({ path }) => {
    if (path === failingOnce && readsOf(fetchMock, path) === 1) {
      return dashboardErrorResponse(503, "upstream unavailable");
    }
    return dashboardDataResponse(
      200,
      path === CURRENT_ORGANIZATION_URL
        ? { id: "org_test/1", name: "Acme", settings: null }
        : access
    );
  });
  render(<MainnetAccessSection />, { wrapper: EnglishDashboardReads });
  return fetchMock;
}

function rowLabels(): (string | null)[] {
  return screen.getAllByRole("term").map((term) => term.textContent);
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MainnetAccessSection", () => {
  it.each([
    [true, "Enable mainnet for your organization.", 1],
    [false, "Mainnet requests aren't open yet.", 0],
  ])("explains Not requested while available is %s", async (available, help, requestButtons) => {
    renderSection(
      {
        state: "not_requested",
        available,
        countryCode: null,
        request: null,
        contactEmail: "mainnet@example.test",
      },
      null
    );

    expect(await screen.findByRole("button", { name: help })).toBeTruthy();
    expect(rowLabels()).toEqual(["Status"]);
    expect(screen.getByRole("definition").textContent).toBe("Not requested");
    expect(screen.queryAllByRole("button", { name: "Request mainnet access" })).toHaveLength(
      requestButtons
    );
  });

  it("reads the organization, then its mainnet access, and shows an approved request", async () => {
    const fetchMock = renderSection(APPROVED, null);

    expect(await screen.findByText("Approved")).toBeTruthy();
    expect(rowLabels()).toEqual(["Status", "Requested", "Terms and Conditions", "Changes"]);
    expect(screen.getByRole("button", { name: "Mainnet is enabled." })).toBeTruthy();
    expect(screen.getByRole("link", { name: "mainnet@example.test" }).getAttribute("href")).toBe(
      "mailto:mainnet@example.test"
    );
    expect(screen.queryByRole("button", { name: "Request mainnet access" })).toBeNull();
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: CURRENT_ORGANIZATION_URL, projectId: SANDBOX_PROJECT.id, demo: null },
      { path: MAINNET_ACCESS_URL, projectId: SANDBOX_PROJECT.id, demo: null },
    ]);
  });

  it.each([CURRENT_ORGANIZATION_URL, MAINNET_ACCESS_URL])(
    "says why when %s fails, and reads it again on retry",
    async (failingPath) => {
      const fetchMock = renderSection(APPROVED, failingPath);
      const user = userEvent.setup();

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Couldn't load mainnet access: upstream unavailable"
      );
      await user.click(screen.getByRole("button", { name: "Try again" }));

      expect(await screen.findByText("Approved")).toBeTruthy();
      expect(readsOf(fetchMock, failingPath)).toBe(2);
    }
  );
});
