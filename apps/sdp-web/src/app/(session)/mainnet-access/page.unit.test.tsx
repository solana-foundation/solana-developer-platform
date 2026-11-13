// @vitest-environment jsdom
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextNavigationMock, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";

const state = vi.hoisted(() => ({ sandboxOnBeta: false }));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/flags", () => ({ sandboxOnBeta: async () => state.sandboxOnBeta }));
vi.mock("@/app/(session)/dashboard/[projectId]/settings/mainnet-access-section", () => ({
  MainnetAccessSection: () => <section>request section</section>,
}));
vi.mock("./mainnet-access-account-actions", () => ({
  MainnetAccessAccountActions: () => null,
}));

import * as mainnetLoad from "@/app/(session)/dashboard/[projectId]/settings/mainnet-access-load";
import MainnetAccessPage from "./page";

const LOCKED: MainnetAccess = {
  state: "not_requested",
  available: true,
  sandboxOnly: false,
  mainnetOnly: true,
  countryCode: null,
  request: null,
  contactEmail: null,
};

function loadAccess(access: MainnetAccess) {
  vi.spyOn(mainnetLoad, "loadMainnetAccess").mockResolvedValue({
    ok: true,
    organizationId: "org_sdp",
    organizationName: "Acme",
    access,
  });
}

beforeEach(() => {
  resetDashboardNavigation();
  state.sandboxOnBeta = false;
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

  it("holds the request and links to the hosted sandbox when the flag is on", async () => {
    loadAccess(LOCKED);
    state.sandboxOnBeta = true;

    render(await MainnetAccessPage(), { wrapper: EnglishI18n });

    expect(screen.getByRole("heading", { name: "Acme isn't on mainnet yet" })).toBeTruthy();
    expect(screen.getByText("request section")).toBeTruthy();
    const sandbox = screen.getByRole("link", { name: "Try the sandbox" });
    expect(sandbox.getAttribute("href")).toBe("https://platform-beta.solana.com");
    expect(sandbox.getAttribute("target")).toBe("_blank");
  });

  it("offers no sandbox link while the flag is off", async () => {
    loadAccess(LOCKED);

    render(await MainnetAccessPage(), { wrapper: EnglishI18n });

    expect(screen.queryByRole("link", { name: "Try the sandbox" })).toBeNull();
  });
});
