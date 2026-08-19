// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCustodyIntegrations } from "@/app/dashboard/integrations/integrations-status";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { IntegrationsCatalog } from "./integrations-catalog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/dashboard/integrations",
}));

// The family axis rides the shell's header tabs through `?tab=`; the catalog
// only reads the resolved value, so the hook stands in for the URL here.
const urlState = vi.hoisted(() => ({ tab: null as string | null }));
vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardTab: () => urlState.tab,
}));

function renderCatalog(overrides: Partial<Parameters<typeof IntegrationsCatalog>[0]> = {}) {
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
        rpc={[
          {
            provider: "helius",
            label: "Helius",
            status: "active",
            descriptionKey: "DashboardCustody.onboardingRpcHeliusDescription",
          },
          { provider: "alchemy", label: "Alchemy", status: "available" },
        ]}
        ramps={[{ provider: "moonpay", label: "MoonPay", status: "enabled" }]}
        compliance={[{ provider: "range", label: "Range", status: "request_access" }]}
      />
    </I18nProvider>
  );
}

function visibleRowLabels(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector("a.text-base, span.text-base")?.textContent ?? "");
}

describe("IntegrationsCatalog filtering", () => {
  beforeEach(() => {
    cleanup();
    urlState.tab = null;
  });

  it("shows every family until a filter narrows it", () => {
    renderCatalog();

    const labels = visibleRowLabels();
    expect(labels).toContain("Privy");
    expect(labels).toContain("Helius");
    expect(labels).toContain("MoonPay");
    expect(labels).toContain("Range");
  });

  it("narrows to the family the header tab selects", () => {
    urlState.tab = "rpc";
    renderCatalog();

    expect(visibleRowLabels()).toEqual(["Helius", "Alchemy"]);
    // The family pills are gone: the header tabs own that axis now, so the
    // page keeps a single secondary row of status pills.
    expect(screen.queryByRole("button", { name: /RPC/ })).toBeNull();
  });

  it("shows every family when the tab value is not a family", () => {
    urlState.tab = "not-a-family";
    renderCatalog();

    const labels = visibleRowLabels();
    expect(labels).toContain("Privy");
    expect(labels).toContain("MoonPay");
  });

  it("keeps the tab narrowing when the in-page filters clear", async () => {
    const user = userEvent.setup();
    urlState.tab = "rpc";
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Connected" }));
    expect(visibleRowLabels()).toEqual(["Helius"]);

    // The status control owns only what this page controls; the header tab
    // is navigation and stays put.
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(visibleRowLabels()).toEqual(["Helius", "Alchemy"]);
  });

  it("narrows by status across families", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Connected" }));

    const labels = visibleRowLabels();
    expect(labels).toEqual(["Privy", "Helius"]);
  });

  it("narrows to what the organization can set up itself", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Ready to connect" }));

    expect(visibleRowLabels()).toEqual(["Para", "Alchemy"]);
  });

  it("narrows to what still needs an access request", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Request access" }));

    const labels = visibleRowLabels();
    // Only providers with a real way to ask collect here: the routed gated
    // custody provider and unactivated compliance. A gated custody provider
    // without a request route (IBM Haven, until HOO-775) is not a request
    // anyone can make, so it holds at not-configured instead.
    for (const gated of ["Fireblocks", "Range"]) {
      expect(labels).toContain(gated);
    }
    expect(labels).not.toContain("IBM Digital Asset Haven");
    // Enabled rails and generally available providers are excluded — an
    // enabled ramp and an uncredentialed general provider are not requests.
    expect(labels).not.toContain("MoonPay");
    expect(labels).not.toContain("Privy");
    expect(labels).not.toContain("Para");
    expect(labels).not.toContain("Turnkey");
  });

  it("narrows to what this deployment has not credentialed", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Not configured" }));

    const labels = visibleRowLabels();
    // Turnkey is generally available but has no credentials in this fixture,
    // and IBM Haven is gated with no request route wired yet (HOO-775).
    expect(labels).toContain("Turnkey");
    expect(labels).toContain("IBM Digital Asset Haven");
    expect(labels).not.toContain("Fireblocks");
  });

  it("offers no filter that would imply an integration does not exist", () => {
    renderCatalog();

    expect(screen.queryByRole("button", { name: "Not available" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pending" })).toBeNull();
  });

  it("searches across families and clears back to everything", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.type(screen.getByRole("searchbox"), "moon");
    expect(visibleRowLabels()).toEqual(["MoonPay"]);

    await user.clear(screen.getByRole("searchbox"));
    expect(visibleRowLabels().length).toBeGreaterThan(5);
  });

  it("offers an empty state with a reset when nothing matches", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.type(screen.getByRole("searchbox"), "zzz-no-such-provider");

    expect(screen.getByText("No integrations match")).toBeTruthy();
    const resets = screen.getAllByRole("button", { name: "Clear filters" });
    await user.click(resets[resets.length - 1] as HTMLElement);
    expect(screen.queryByText("No integrations match")).toBeNull();
  });

  it("keeps cards action-free: browsing here, acting on the detail page", () => {
    renderCatalog();

    // RPC is managed on each provider's own page now (HOO-787), so the section
    // no longer signposts Settings.
    expect(screen.queryAllByRole("link", { name: "Change in Settings" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Manage" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Configure" })).toHaveLength(0);
    expect(screen.queryAllByRole("link", { name: "Request access" })).toHaveLength(0);
    // Every card is a navigation target to its provider detail.
    const privy = screen.getByRole("link", { name: "Privy" });
    expect(privy.getAttribute("href")).toBe("/dashboard/integrations/privy");
  });

  it("fills every row with a description instead of dead space", () => {
    renderCatalog();

    expect(screen.getByText("Use Helius infrastructure for Solana RPC requests.")).toBeTruthy();
  });

  it("keeps the custody-unknown alert off other family tabs", () => {
    urlState.tab = "rpc";
    renderCatalog({ custody: null });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still renders the custody-unknown alert alongside the filters", () => {
    renderCatalog({ custody: null });

    expect(screen.getByRole("alert").textContent).toContain(
      "Custody connection state is unavailable"
    );
  });
});
