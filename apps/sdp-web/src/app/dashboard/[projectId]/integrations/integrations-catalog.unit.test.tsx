// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCustodyIntegrations } from "@/app/dashboard/[projectId]/integrations/integrations-status";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { SANDBOX_PROJECT } from "@/test/projects";
import { IntegrationsCatalog } from "./integrations-catalog";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const urlState = vi.hoisted(() => ({ tab: null as string | null }));
vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardTab: () => urlState.tab,
}));

function renderCatalog(overrides: Partial<Parameters<typeof IntegrationsCatalog>[0]>) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <IntegrationsCatalog
        custody={
          overrides.custody !== undefined
            ? overrides.custody
            : resolveCustodyIntegrations({
                connectedProviders: ["privy"],
                enabledProviders: ["privy", "para"],
              })
        }
        ramps={[
          {
            provider: "moonpay",
            label: "MoonPay",
            status: "enabled",
            descriptionKey: "Shared.integrations.rampMoonpayDescription",
          },
          { provider: "lightspark", label: "Lightspark", status: "enabled" },
        ]}
        compliance={[{ provider: "range", label: "Range", status: "request_access" }]}
        privacy={overrides.privacy}
        enabledFamilies={overrides.enabledFamilies}
      />
    </I18nProvider>
  );
}

function visibleRowLabels(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector("a.text-base, span.text-base")?.textContent ?? "");
}

describe("IntegrationsCatalog", () => {
  beforeEach(() => {
    cleanup();
    urlState.tab = null;
  });

  it("uses a category hub on the landing page without status filters", () => {
    renderCatalog({});

    expect(document.querySelector("[data-integrations-hub='true']")).toBeTruthy();
    expect(document.querySelectorAll("[data-integration-hub-action]")).toHaveLength(4);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText("All")).toBeNull();
    for (const removed of ["All", "Connected", "Not connected", "Available on request"]) {
      expect(screen.queryByRole("button", { name: removed })).toBeNull();
    }
  });

  it("shows a provider catalog only for the sidebar category that is selected", () => {
    urlState.tab = "ramps";
    renderCatalog({});

    expect(visibleRowLabels()).toEqual(["MoonPay", "Lightspark"]);
    expect(document.querySelector("[data-integrations-hub='true']")).toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("returns disabled and unknown categories to the hub", () => {
    urlState.tab = "custody";
    renderCatalog({ enabledFamilies: ["ramps"] });

    expect(document.querySelectorAll("[data-integration-hub-action]")).toHaveLength(1);
    expect(document.querySelector("[data-integration-hub-action='ramps']")).toBeTruthy();
  });

  it("searches within the selected category", async () => {
    const user = userEvent.setup();
    urlState.tab = "ramps";
    renderCatalog({});

    await user.type(screen.getByRole("searchbox"), "lightspark");
    expect(visibleRowLabels()).toEqual(["Lightspark"]);

    await user.clear(screen.getByRole("searchbox"));
    expect(visibleRowLabels()).toEqual(["MoonPay", "Lightspark"]);
  });

  it("offers an empty state with a reset when nothing matches", async () => {
    const user = userEvent.setup();
    urlState.tab = "ramps";
    renderCatalog({});

    await user.type(screen.getByRole("searchbox"), "zzz-no-such-provider");

    expect(screen.getByText("No integrations match")).toBeTruthy();
    const resets = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(resets[resets.length - 1] as HTMLElement);
    expect(screen.queryByText("No integrations match")).toBeNull();
  });

  it("keeps cards action-free: browsing here, acting on the detail page", () => {
    urlState.tab = "custody";
    renderCatalog({});

    expect(screen.queryAllByRole("link", { name: "Change in Settings" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Manage" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Configure" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Request access" })).toHaveLength(0);
    const privy = screen.getByRole("link", { name: "Privy" });
    expect(privy.getAttribute("href")).toBe(`/dashboard/${SANDBOX_PROJECT.id}/integrations/privy`);
  });

  it("fills every row with a description instead of dead space", () => {
    urlState.tab = "ramps";
    renderCatalog({});

    expect(screen.getByText("Card and bank fiat onramp and offramp.")).toBeTruthy();
  });

  it("keeps the custody-unknown alert off other family tabs", () => {
    urlState.tab = "ramps";
    renderCatalog({ custody: null });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the custody-unknown alert in the custody catalog", () => {
    urlState.tab = "custody";
    renderCatalog({ custody: null });

    expect(screen.getByRole("alert").textContent).toContain(
      "Custody connection state is unavailable"
    );
  });
});
