// @vitest-environment jsdom

import type { ProjectIntegrations } from "@sdp/types/integrations";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardHeaderTabsTrailingContext } from "@/components/dashboard-header-tabs-trailing-context";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { SANDBOX_PROJECT } from "@/test/projects";
import { IntegrationsCatalog } from "./integrations-catalog";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const INTEGRATIONS: ProjectIntegrations = {
  projectId: SANDBOX_PROJECT.id,
  environment: "sandbox",
  families: [
    {
      family: "custody",
      integrations: [
        { provider: "privy", category: "server", state: { status: "connected", mode: "byok" } },
        {
          provider: "fireblocks",
          category: "institutional",
          state: { status: "not_configured", modes: ["byok"] },
        },
      ],
    },
    {
      family: "rpc",
      integrations: [
        { provider: "helius", state: { status: "provided", modes: [] } },
        { provider: "triton", state: { status: "provided", modes: [] } },
      ],
    },
    {
      family: "ramps",
      integrations: [{ provider: "moonpay", state: { status: "provided", modes: [] } }],
    },
    {
      family: "private_channels",
      integrations: [
        {
          provider: "private_channels",
          state: { status: "not_configured", modes: ["managed"] },
        },
      ],
    },
  ],
};

function renderCatalog(): void {
  render(<IntegrationsCatalog integrations={INTEGRATIONS} />, { wrapper: EnglishI18n });
}

function sectionTitles(): (string | null)[] {
  return screen.queryAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
}

function section(title: string): HTMLElement {
  const container = screen.getByRole("heading", { level: 2, name: title }).closest("section");
  assert(container !== null);
  return container;
}

function row(sectionTitle: string, label: string): HTMLElement {
  const item = within(section(sectionTitle)).getByText(label).closest("li");
  assert(item !== null);
  return item;
}

describe("IntegrationsCatalog", () => {
  beforeEach(() => {
    setDashboardUrl(`/dashboard/${SANDBOX_PROJECT.id}/integrations`, {});
    renderCatalog();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders one section per family in the response, in its order", () => {
    expect(sectionTitles()).toEqual(["Custody", "RPC", "Ramps", "Privacy"]);
  });

  it("labels each row with its state", () => {
    expect(within(row("Custody", "Privy")).getByText("Connected")).toBeTruthy();
    expect(within(row("Custody", "Fireblocks")).getByText("Not configured")).toBeTruthy();
    expect(within(row("RPC", "Helius")).getByText("Provided by SDP")).toBeTruthy();
    expect(within(row("Ramps", "MoonPay")).getByText("Provided by SDP")).toBeTruthy();
    expect(within(row("Privacy", "Private Channels")).getByText("Not configured")).toBeTruthy();
  });

  it("counts connected rows only on sections with something to configure", () => {
    expect(within(section("Custody")).getByText("1 of 2 connected")).toBeTruthy();
    expect(within(section("Privacy")).getByText("0 of 1 connected")).toBeTruthy();
    expect(within(section("Ramps")).queryByText(/connected$/)).toBeNull();
  });

  it("shows each custody provider's category", () => {
    expect(within(row("Custody", "Privy")).getByText("API")).toBeTruthy();
    expect(within(row("Custody", "Fireblocks")).getByText("Institutional")).toBeTruthy();
  });

  it("links only the rows a project can configure, each to its page in this project", () => {
    expect(
      screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])
    ).toEqual([
      ["Privy", `/dashboard/${SANDBOX_PROJECT.id}/integrations/privy`],
      ["Fireblocks", `/dashboard/${SANDBOX_PROJECT.id}/integrations/fireblocks`],
      [
        "Private Channels",
        `/dashboard/${SANDBOX_PROJECT.id}/integrations/private-channels/overview`,
      ],
    ]);
  });
});

describe("IntegrationsCatalog tabs and search", () => {
  const catalogUrl = `/dashboard/${SANDBOX_PROJECT.id}/integrations`;
  let slot: HTMLDivElement;

  function openCatalog(search: string): void {
    window.history.replaceState(null, "", `${catalogUrl}${search}`);
    setDashboardUrl(`${catalogUrl}${search}`, {});
    render(<IntegrationsCatalog integrations={INTEGRATIONS} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <EnglishI18n>
          <DashboardHeaderTabsTrailingContext.Provider value={slot}>
            {children}
          </DashboardHeaderTabsTrailingContext.Provider>
        </EnglishI18n>
      ),
    });
  }

  beforeEach(() => {
    slot = document.createElement("div");
    document.body.append(slot);
  });

  afterEach(() => {
    cleanup();
    slot.remove();
    window.history.replaceState(null, "", "/");
  });

  it("shows only the section a family tab names", () => {
    openCatalog("?tab=ramps");

    expect(sectionTitles()).toEqual(["Ramps"]);
  });

  it("says a family tab with nothing for the project is empty", () => {
    openCatalog("?tab=compliance");

    expect(sectionTitles()).toEqual([]);
    expect(screen.getByText("Nothing in this family for this project yet.")).toBeTruthy();
  });

  it("filters rows by provider name or id, hiding sections without a match", async () => {
    const user = userEvent.setup();
    openCatalog("");
    const search = screen.getByRole("searchbox", { name: "Search integrations" });

    await user.type(search, "fire");
    expect(sectionTitles()).toEqual(["Custody"]);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Fireblocks"),
    ]);

    await user.clear(search);
    await user.type(search, "private_channels");
    expect(sectionTitles()).toEqual(["Privacy"]);
  });

  it("offers to clear a search nothing matches, restoring every section", async () => {
    const user = userEvent.setup();
    openCatalog("");

    await user.type(screen.getByRole("searchbox"), "no-such-provider");
    expect(sectionTitles()).toEqual([]);
    expect(screen.getByText("No integrations match")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(sectionTitles()).toEqual(["Custody", "RPC", "Ramps", "Privacy"]);
  });
});
