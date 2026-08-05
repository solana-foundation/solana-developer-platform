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
        ramps={[{ provider: "moonpay", label: "MoonPay", status: "unavailable" }]}
        compliance={[{ provider: "range", label: "Range", status: "unavailable" }]}
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
  });

  it("shows every family until a filter narrows it", () => {
    renderCatalog();

    const labels = visibleRowLabels();
    expect(labels).toContain("Privy");
    expect(labels).toContain("Helius");
    expect(labels).toContain("MoonPay");
    expect(labels).toContain("Range");
  });

  it("narrows to one family from the pills and shows counts", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: /RPC · 2/ }));

    const labels = visibleRowLabels();
    expect(labels).toEqual(["Helius", "Alchemy"]);
  });

  it("narrows by status across families", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.click(screen.getByRole("button", { name: "Active" }));

    const labels = visibleRowLabels();
    expect(labels).toEqual(["Privy", "Helius"]);
  });

  it("searches across families and clears back to everything", async () => {
    const user = userEvent.setup();
    renderCatalog();

    await user.type(screen.getByRole("searchbox"), "moon");
    expect(visibleRowLabels()).toEqual(["MoonPay"]);

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
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

    // Shared destinations link once at the section level, never per card.
    expect(screen.getAllByRole("link", { name: "Change in Settings" })).toHaveLength(1);
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

  it("still renders the custody-unknown alert alongside the filters", () => {
    renderCatalog({ custody: null });

    expect(screen.getByRole("alert").textContent).toContain(
      "Custody connection state is unavailable"
    );
  });
});
