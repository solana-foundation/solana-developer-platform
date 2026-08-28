import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-workspace-switcher="true" />,
}));

import { DashboardBottomNav } from "./dashboard-bottom-nav";
import { DashboardMoreSheet } from "./dashboard-more-sheet";
import { getNavSections, withSubnavOpen, withSubnavToggled } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;

function navOptions(overrides: Partial<Parameters<typeof getNavSections>[1]> = {}) {
  return {
    canReadApprovals: false,
    earnEnabled: false,
    heliusRingsEnabled: false,
    marketsEnabled: false,
    paymentsEnabled: true,
    pendingApprovalCount: null,
    privateChannelsEnabled: false,
    ...overrides,
  };
}

function findManageItem(options: ReturnType<typeof navOptions>, label: string) {
  return getNavSections(t, options)
    .find((section) => section.title === "Shared.dashboardShell.manage")
    ?.items.find((item) => item.label === label);
}

function moreSheetMarkup(
  overrides: Partial<ComponentProps<typeof DashboardMoreSheet>> = {}
): string {
  return renderToStaticMarkup(
    <DashboardMoreSheet
      pathname="/dashboard"
      canReadApprovals={false}
      canManageOrgSettings={false}
      earnEnabled={false}
      heliusRingsEnabled={false}
      marketsEnabled={false}
      onClose={() => {}}
      {...overrides}
    />
  );
}

describe("Markets dashboard navigation", () => {
  const findMarketsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.markets");

  it("adds the ordered Treasury Solutions and Earn Program destinations when enabled", () => {
    const markets = findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: true }));

    expect(markets?.href).toBe("/dashboard/markets");
    expect(markets?.subnavKey).toBe("markets");
    expect(markets?.children).toEqual([
      {
        label: "Shared.dashboardShell.treasurySolutions",
        href: "/dashboard/markets/treasury-solutions",
      },
      {
        label: "Shared.dashboardShell.earnProgram",
        href: "/dashboard/markets/earn",
      },
    ]);
  });

  it("hides the Markets group when the module flag is off, whatever the sub-module says", () => {
    const options = navOptions({ marketsEnabled: false, earnEnabled: true });

    expect(findMarketsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
  });

  it("hides provider-backed Markets when the Earn runtime is off", () => {
    expect(
      findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: false }))
    ).toBeUndefined();
  });

  it("keeps Markets out of the mobile More sheet when the module flag is off", () => {
    expect(moreSheetMarkup({ earnEnabled: true, marketsEnabled: false })).not.toContain(
      'href="/dashboard/markets"'
    );
  });

  it("exposes the active Markets destination from the mobile More sheet", () => {
    const markup = moreSheetMarkup({
      pathname: "/dashboard/markets/treasury-solutions",
      earnEnabled: true,
      marketsEnabled: true,
    });

    expect(markup).toContain('href="/dashboard/markets"');
    expect(markup).toContain("Shared.dashboardShell.markets");
    expect(markup).toContain('aria-current="page"');
  });
});

describe("Helius Rings dashboard navigation", () => {
  const findHeliusRingsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.heliusRings");

  it("shows the entry under Manage when the flag is on", () => {
    const item = findHeliusRingsItem(navOptions({ heliusRingsEnabled: true }));

    expect(item?.href).toBe("/dashboard/helius-rings");
    expect(item?.children).toBeUndefined();
  });

  it("hides the entry when the flag is off", () => {
    expect(findHeliusRingsItem(navOptions({ heliusRingsEnabled: false }))).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, navOptions()))).not.toContain(
      "Shared.dashboardShell.heliusRings"
    );
  });

  it("surfaces the entry in the mobile More sheet when the flag is on", () => {
    const markup = moreSheetMarkup({ heliusRingsEnabled: true });

    expect(markup).toContain('href="/dashboard/helius-rings"');
    expect(markup).toContain("Shared.dashboardShell.heliusRings");
  });

  it("keeps the entry out of the mobile More sheet when the flag is off", () => {
    expect(moreSheetMarkup()).not.toContain("/dashboard/helius-rings");
  });
});

describe("Payments dashboard navigation", () => {
  const findPaymentsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.payments");

  it("shows the entry with its ordered subnav under Manage when the flag is on", () => {
    const item = findPaymentsItem(navOptions());

    expect(item?.href).toBe("/dashboard/payments");
    expect(item?.subnavKey).toBe("payments");
    expect(item?.children?.map((child) => child.label)).toEqual([
      "Shared.dashboardShell.transactions",
      "Shared.dashboardShell.counterparty",
      "Shared.dashboardShell.pay",
      "Shared.dashboardShell.deposit",
      "Shared.dashboardShell.requests",
      "Shared.dashboardShell.recurring",
    ]);
  });

  it("drops the entry and every payments destination when the flag is off", () => {
    const options = navOptions({ paymentsEnabled: false });

    expect(findPaymentsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.payments");
  });

  it("shows the bottom-bar tab when the flag is on", () => {
    const markup = renderToStaticMarkup(
      <DashboardBottomNav pathname="/dashboard" paymentsEnabled onOpenMore={() => {}} />
    );

    expect(markup).toContain('href="/dashboard/payments"');
    expect(markup).toContain("Shared.dashboardShell.payments");
  });

  it("keeps the bottom-bar tab out when the flag is off", () => {
    const markup = renderToStaticMarkup(
      <DashboardBottomNav pathname="/dashboard" paymentsEnabled={false} onOpenMore={() => {}} />
    );

    expect(markup).not.toContain("/dashboard/payments");
  });
});

describe("subnav open state", () => {
  const closed = { payments: false, markets: false } as const;

  it("opens a section when its top-level item is followed", () => {
    // Gui's ask: clicking Payments in the side nav expands the Payments
    // submenu rather than only navigating to it (HOO-1218).
    expect(withSubnavOpen(closed, "payments")).toEqual({ payments: true, markets: false });
  });

  it("never closes the section being navigated into", () => {
    // The whole reason this is not a toggle. A second click on the section you
    // are already inside would otherwise hide the pages you are looking at.
    const open = { payments: true, markets: false };
    expect(withSubnavOpen(open, "payments").payments).toBe(true);
  });

  it("returns the same object when the section is already open", () => {
    // Held in React state, so a click that decides nothing must not re-render
    // the whole shell.
    const open = { payments: true, markets: false };
    expect(withSubnavOpen(open, "payments")).toBe(open);
  });

  it("leaves other sections alone", () => {
    expect(withSubnavOpen({ payments: false, markets: true }, "payments")).toEqual({
      payments: true,
      markets: true,
    });
  });

  it("still flips both ways for the chevron", () => {
    expect(withSubnavToggled(closed, "markets").markets).toBe(true);
    expect(withSubnavToggled({ payments: false, markets: true }, "markets").markets).toBe(false);
  });
});
