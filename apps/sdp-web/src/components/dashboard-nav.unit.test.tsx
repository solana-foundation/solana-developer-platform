import { LandmarkIcon, PercentIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/components/workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-workspace-switcher="true" />,
}));

vi.mock("@/components/sidebar-user-menu", () => ({
  SidebarUserMenu: () => <div data-sidebar-user-menu="true" />,
}));

import { DashboardBottomNav } from "./dashboard-bottom-nav";
import { DashboardMoreSheet } from "./dashboard-more-sheet";
import { getNavSections, withSubnavOpen, withSubnavToggled } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;

const SANDBOX_DASHBOARD = `/dashboard/${SANDBOX_PROJECT.id}`;

beforeEach(() => {
  resetDashboardNavigation();
});

function navOptions(overrides: Partial<Parameters<typeof getNavSections>[1]>) {
  return {
    canReadApprovals: false,
    complianceEnabled: true,
    custodyEnabled: true,
    dvpEnabled: false,
    earnEnabled: false,
    heliusRingsEnabled: false,
    issuanceEnabled: true,
    marketsEnabled: false,
    paymentsEnabled: true,
    pendingApprovalCount: null,
    policiesEnabled: true,
    privateChannelsEnabled: false,
    rampsEnabled: true,
    ...overrides,
  };
}

function findManageItem(options: ReturnType<typeof navOptions>, label: string) {
  return getNavSections(t, options)
    .find((section) => section.title === "Shared.dashboardShell.manage")
    ?.items.find((item) => item.label === label);
}

function moreSheetMarkup(overrides: Partial<ComponentProps<typeof DashboardMoreSheet>>): string {
  return renderToStaticMarkup(
    <DashboardMoreSheet
      pathname="/dashboard"
      canReadApprovals={false}
      canManageOrgSettings={false}
      dvpEnabled={false}
      earnEnabled={false}
      heliusRingsEnabled={false}
      marketsEnabled={false}
      policiesEnabled
      onClose={() => {}}
      {...overrides}
    />
  );
}

describe("Markets dashboard navigation", () => {
  const findMarketsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.markets");

  it("adds the ordered Treasury and Embedded Yield destinations when enabled", () => {
    const markets = findMarketsItem(navOptions({ marketsEnabled: true, earnEnabled: true }));

    expect(markets?.href).toBe("/dashboard/markets");
    expect(markets?.subnavKey).toBe("markets");
    expect(markets?.children).toEqual([
      {
        label: "Shared.dashboardShell.treasurySolutions",
        href: "/dashboard/markets/treasury-solutions",
        icon: LandmarkIcon,
      },
      {
        label: "Shared.dashboardShell.earnProgram",
        href: "/dashboard/markets/embedded-yield",
        icon: PercentIcon,
      },
    ]);
  });

  it("hides the Markets group when the module flag is off, whatever the sub-module says", () => {
    const options = navOptions({ marketsEnabled: false, earnEnabled: true });

    expect(findMarketsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.markets");
  });

  it("still lists Treasury when every sub-module flag is off", () => {
    const markets = findMarketsItem(
      navOptions({ marketsEnabled: true, earnEnabled: false, dvpEnabled: false })
    );

    expect(markets?.children?.map((child) => child.href)).toEqual([
      "/dashboard/markets/treasury-solutions",
    ]);
  });

  it("shows Markets for a DvP-only organization", () => {
    const markets = findMarketsItem(
      navOptions({ marketsEnabled: true, earnEnabled: false, dvpEnabled: true })
    );

    expect(markets).toBeDefined();
    expect(markets?.children?.map((child) => child.href)).toEqual([
      "/dashboard/markets/treasury-solutions",
      "/dashboard/markets/dvp",
    ]);
  });

  it("omits DvP from the sub-nav when its own flag is off", () => {
    const markets = findMarketsItem(
      navOptions({ marketsEnabled: true, earnEnabled: true, dvpEnabled: false })
    );

    expect(markets?.children?.map((child) => child.href)).not.toContain("/dashboard/markets/dvp");
  });

  it("keeps Markets out of the mobile More sheet when the module flag is off", () => {
    expect(moreSheetMarkup({ earnEnabled: true, marketsEnabled: false })).not.toContain(
      `href="${SANDBOX_DASHBOARD}/markets"`
    );
  });

  it("exposes the active Markets destination from the mobile More sheet", () => {
    const markup = moreSheetMarkup({
      pathname: "/dashboard/markets/treasury-solutions",
      earnEnabled: true,
      marketsEnabled: true,
    });

    expect(markup).toContain(`href="${SANDBOX_DASHBOARD}/markets"`);
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
    expect(JSON.stringify(getNavSections(t, navOptions({})))).not.toContain(
      "Shared.dashboardShell.heliusRings"
    );
  });

  it("surfaces the entry in the mobile More sheet when the flag is on", () => {
    const markup = moreSheetMarkup({ heliusRingsEnabled: true });

    expect(markup).toContain(`href="${SANDBOX_DASHBOARD}/helius-rings"`);
    expect(markup).toContain("Shared.dashboardShell.heliusRings");
  });

  it("keeps the entry out of the mobile More sheet when the flag is off", () => {
    expect(moreSheetMarkup({})).not.toContain("/helius-rings");
  });
});

describe("Payments dashboard navigation", () => {
  const findPaymentsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.payments");

  it("shows the entry with its ordered subnav under Manage when the flag is on", () => {
    const item = findPaymentsItem(navOptions({}));

    expect(item?.href).toBe("/dashboard/payments");
    expect(item?.subnavKey).toBe("payments");
    expect(item?.children?.map((child) => child.label)).toEqual([
      "Shared.dashboardShell.transactions",
      "Shared.dashboardShell.contacts",
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
});

describe("Integrations dashboard navigation", () => {
  const findIntegrationsItem = (options: ReturnType<typeof navOptions>) =>
    findManageItem(options, "Shared.dashboardShell.integrations");

  it("groups every enabled family under the Integrations submenu", () => {
    const item = findIntegrationsItem(
      navOptions({
        complianceEnabled: true,
        custodyEnabled: true,
        paymentsEnabled: true,
        policiesEnabled: true,
        privateChannelsEnabled: true,
        rampsEnabled: true,
      })
    );

    expect(item?.subnavKey).toBe("integrations");
    expect(item?.children?.map((child) => child.href)).toEqual([
      "/dashboard/integrations?tab=custody",
      "/dashboard/integrations?tab=ramps",
      "/dashboard/integrations?tab=compliance",
      "/dashboard/integrations?tab=privacy",
    ]);
    expect(item?.children?.every((child) => child.icon)).toBe(true);
  });

  it("lists no family when every owning module is disabled", () => {
    const item = findIntegrationsItem(
      navOptions({
        complianceEnabled: false,
        custodyEnabled: false,
        paymentsEnabled: false,
        policiesEnabled: false,
        privateChannelsEnabled: false,
        rampsEnabled: false,
      })
    );

    expect(item?.children).toEqual([]);
  });

  it("drops Ramps when no ramp provider is enabled, even with Payments on", () => {
    const item = findIntegrationsItem(navOptions({ paymentsEnabled: true, rampsEnabled: false }));

    expect(item?.children?.map((child) => child.href)).not.toContain(
      "/dashboard/integrations?tab=ramps"
    );
  });
});

describe("module entries", () => {
  it.each([
    { options: { custodyEnabled: false }, label: "Shared.dashboardShell.wallets" },
    { options: { issuanceEnabled: false }, label: "Shared.dashboardShell.issuance" },
  ])("drops $label when its module is disabled", ({ options, label }) => {
    expect(JSON.stringify(getNavSections(t, navOptions(options)))).not.toContain(label);
  });
});

describe("mobile bottom bar", () => {
  it("links every enabled module inside the URL's Project", () => {
    setDashboardUrl(`/dashboard/${PRODUCTION_PROJECT.id}`, {});
    const markup = renderToStaticMarkup(
      <DashboardBottomNav
        pathname="/dashboard"
        custodyEnabled
        issuanceEnabled
        paymentsEnabled
        onOpenMore={() => {}}
      />
    );

    for (const segment of ["wallets", "payments", "issuance"]) {
      expect(markup).toContain(`href="/dashboard/${PRODUCTION_PROJECT.id}/${segment}"`);
    }
  });

  it.each([
    { segment: "wallets", custodyEnabled: false, issuanceEnabled: true, paymentsEnabled: true },
    { segment: "payments", custodyEnabled: true, issuanceEnabled: true, paymentsEnabled: false },
    { segment: "issuance", custodyEnabled: true, issuanceEnabled: false, paymentsEnabled: true },
  ])("keeps /$segment out when its module is disabled", ({ segment, ...flags }) => {
    const markup = renderToStaticMarkup(
      <DashboardBottomNav pathname="/dashboard" onOpenMore={() => {}} {...flags} />
    );

    expect(markup).not.toContain(`/${segment}"`);
  });
});

describe("Policies dashboard navigation", () => {
  it("hides Policies and Approvals while retaining API Keys when the module is disabled", () => {
    const options = navOptions({ canReadApprovals: true, policiesEnabled: false });
    const navigation = JSON.stringify(getNavSections(t, options));

    expect(navigation).not.toContain("Shared.dashboardShell.policies");
    expect(navigation).not.toContain("Shared.dashboardShell.approvals");
    expect(navigation).toContain("Shared.dashboardShell.apiKeys");
  });

  it("keeps Policies and Approvals out of the mobile More sheet without hiding API Keys", () => {
    const markup = moreSheetMarkup({
      canReadApprovals: true,
      policiesEnabled: false,
    });

    expect(markup).not.toContain("/policies");
    expect(markup).not.toContain("/approvals");
    expect(markup).toContain(`href="${SANDBOX_DASHBOARD}/api-keys"`);
  });
});

describe("subnav open state", () => {
  const closed = { integrations: false, payments: false, markets: false } as const;

  it("opens a section when its top-level item is followed", () => {
    expect(withSubnavOpen(closed, "payments")).toEqual({
      integrations: false,
      payments: true,
      markets: false,
    });
  });

  it("never closes the section being navigated into", () => {
    const open = { integrations: false, payments: true, markets: false };
    expect(withSubnavOpen(open, "payments").payments).toBe(true);
  });

  it("returns the same object when the section is already open", () => {
    const open = { integrations: false, payments: true, markets: false };
    expect(withSubnavOpen(open, "payments")).toBe(open);
  });

  it("leaves other sections alone", () => {
    expect(
      withSubnavOpen({ integrations: false, payments: false, markets: true }, "payments")
    ).toEqual({
      integrations: false,
      payments: true,
      markets: true,
    });
  });

  it("still flips both ways for the chevron", () => {
    expect(withSubnavToggled(closed, "markets").markets).toBe(true);
    expect(
      withSubnavToggled({ integrations: false, payments: false, markets: true }, "markets").markets
    ).toBe(false);
  });
});
