// @vitest-environment jsdom
import type { MainnetAccess } from "@sdp/types/mainnet-access";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";
import * as mainnetLoad from "./mainnet-access-load";
import { MainnetAccessSection } from "./mainnet-access-section";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("next/headers", () => import("@/test/next-headers"));

async function renderSection(access: MainnetAccess) {
  vi.spyOn(mainnetLoad, "loadMainnetAccess").mockResolvedValue({
    ok: true,
    organizationId: "org_sdp",
    organizationName: "Acme",
    access,
  });
  render(await MainnetAccessSection(), { wrapper: EnglishI18n });
}

function rowLabels(): (string | null)[] {
  return screen.getAllByRole("term").map((term) => term.textContent);
}

beforeEach(() => {
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/settings`);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MainnetAccessSection", () => {
  it.each([
    [
      true,
      "The sandbox is open to everyone. SDP turns on mainnet for Acme once, when an Admin asks, and every project then has a production.",
      1,
    ],
    [false, "Mainnet requests aren't open yet.", 0],
  ])("explains Sandbox only while available is %s", async (available, help, requestButtons) => {
    await renderSection({
      state: "not_requested",
      available,
      countryCode: null,
      request: null,
      contactEmail: "mainnet@example.test",
    });

    expect(rowLabels()).toEqual(["Status"]);
    expect(screen.getByRole("definition").textContent).toBe("Sandbox only");
    expect(screen.getByRole("button", { name: help })).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Request mainnet access…" })).toHaveLength(
      requestButtons
    );
  });

  it("shows an approved request with the address for changes", async () => {
    await renderSection({
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
    });

    expect(rowLabels()).toEqual(["Status", "Requested", "Terms and Conditions", "Changes"]);
    expect(screen.getByText("On")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Every project in Acme has a production, on mainnet." })
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "mainnet@example.test" }).getAttribute("href")).toBe(
      "mailto:mainnet@example.test"
    );
    expect(screen.queryByRole("button", { name: "Request mainnet access…" })).toBeNull();
  });

  it("shows a request in review as a band, not a status row", async () => {
    await renderSection({
      state: "pending",
      available: true,
      countryCode: "SG",
      request: {
        requestedAt: "2026-11-01T12:00:00.000Z",
        requestedByUserId: "user_test_admin",
        termsVersion: "2026-10",
        notified: true,
      },
      contactEmail: "mainnet@example.test",
    });

    expect(screen.getByText("In review")).toBeTruthy();
    expect(
      screen.getByText(
        "SDP reviews every request by hand and emails the Admins once mainnet is on for Acme."
      )
    ).toBeTruthy();
    expect(rowLabels()).toEqual(["Requested", "Based in", "Terms and Conditions", "Changes"]);
  });
});
