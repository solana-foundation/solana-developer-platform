// @vitest-environment jsdom
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import type { OrganizationRole } from "@sdp/types/roles";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mainnetLoad from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-load";
import * as sdpApi from "@/lib/sdp-api";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import MainnetAccessPage from "./page";

const state = vi.hoisted(() => ({ sandboxOnBeta: false, betaLabel: false }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/flags", () => ({
  sandboxOnBeta: async () => state.sandboxOnBeta,
  betaLabel: async () => state.betaLabel,
}));
// Clerk's prebuilt switcher needs a loaded Clerk; the page's own controls around it are real.
vi.mock("@clerk/nextjs", () => ({
  OrganizationSwitcher: () => <button type="button">Switch organization</button>,
  useClerk: () => ({ signOut: vi.fn() }),
}));

const LOCKED: MainnetAccess = {
  state: "not_requested",
  available: true,
  sandboxOnly: false,
  mainnetOnly: true,
  countryCode: null,
  request: null,
  contactEmail: "mainnet@example.test",
};

function loadAccess(access: MainnetAccess, role: OrganizationRole = "admin") {
  vi.spyOn(mainnetLoad, "loadMainnetAccess").mockResolvedValue({
    ok: true,
    organizationId: "org_sdp",
    organizationName: "Acme",
    access,
  });
  vi.spyOn(sdpApi, "requestMemberRole").mockResolvedValue(role);
}

async function renderPage() {
  render(await MainnetAccessPage(), { wrapper: EnglishI18n });
}

beforeEach(() => {
  resetDashboardNavigation();
  state.sandboxOnBeta = false;
  state.betaLabel = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mainnet request page", () => {
  it.each([
    ["a deployment that also serves the sandbox", { ...LOCKED, mainnetOnly: false }],
    ["an organization SDP has turned mainnet on for", { ...LOCKED, state: "approved" as const }],
  ])("sends %s back to the dashboard", async (_, access) => {
    loadAccess(access);

    await expect(MainnetAccessPage()).rejects.toThrow("NEXT_REDIRECT");
    expect(nextNavigationMock.redirect.mock.calls).toEqual([["/dashboard"]]);
  });

  it("offers an admin the request and the hosted sandbox when the flag is on", async () => {
    loadAccess(LOCKED);
    state.sandboxOnBeta = true;

    await renderPage();

    expect(screen.getByRole("heading", { name: "Acme isn't on mainnet yet" })).toBeTruthy();
    expect(
      screen.getByText("You can request mainnet access below or try the sandbox.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request mainnet access" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    const sandbox = screen.getByRole("link", { name: "Try the sandbox" });
    expect(sandbox.getAttribute("href")).toBe("https://platform-beta.solana.com");
    expect(sandbox.getAttribute("target")).toBe("_blank");
  });

  it("asks a member to go to an admin, without the request", async () => {
    loadAccess(LOCKED, "member");

    await renderPage();

    expect(screen.getByText("Ask an Admin of Acme to request mainnet access.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request mainnet access" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Try the sandbox" })).toBeNull();
  });

  it("says the request is in review once an admin has sent it", async () => {
    loadAccess({
      ...LOCKED,
      state: "pending",
      request: {
        requestedAt: "2026-11-12T12:00:00.000Z",
        requestedByUserId: "user_test_admin",
        termsVersion: "2026-11-03",
        notified: true,
      },
    });
    state.sandboxOnBeta = true;

    await renderPage();

    expect(
      screen.getByText("Acme has requested mainnet access. You can try the sandbox while you wait.")
    ).toBeTruthy();
    expect(screen.getByText("In review")).toBeTruthy();
  });

  it("badges the product name Beta on the hosted sandbox", async () => {
    loadAccess(LOCKED);
    state.betaLabel = true;

    await renderPage();

    expect(screen.getByText("Beta")).toBeTruthy();
  });
});
