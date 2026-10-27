import { LandmarkIcon, PercentIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";

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

import { getNavSections, withSubnavOpen, withSubnavToggled } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;

beforeEach(() => {
  resetDashboardNavigation();
});

function navOptions(overrides: Partial<Parameters<typeof getNavSections>[1]>) {
  return {
    complianceEnabled: true,
    custodyEnabled: true,
    dvpEnabled: false,
    earnEnabled: false,
    heliusRingsEnabled: false,
    issuanceEnabled: true,
    marketsEnabled: false,
    paymentsEnabled: true,
    privateChannelsEnabled: false,
    rampsEnabled: true,
    canWrite: true,
    ...overrides,
  };
}

function findManageItem(options: ReturnType<typeof navOptions>, label: string) {
  return getNavSections(t, options)
    .find((section) => section.title === "Shared.dashboardShell.manage")
    ?.items.find((item) => item.label === label);
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
      "Shared.dashboardShell.newDesign.recurring",
    ]);
  });

  it("drops the entry and every payments destination when the flag is off", () => {
    const options = navOptions({ paymentsEnabled: false });

    expect(findPaymentsItem(options)).toBeUndefined();
    expect(JSON.stringify(getNavSections(t, options))).not.toContain("dashboardShell.payments");
  });
});

describe("Payments navigation for a read-only member", () => {
  it("leaves out Pay and keeps Deposit", () => {
    const hrefs = (canWrite: boolean) =>
      findManageItem(navOptions({ canWrite }), "Shared.dashboardShell.payments")?.children?.map(
        (child) => child.href
      );

    expect(hrefs(true)).toContain("/dashboard/payments/pay");
    expect(hrefs(false)).not.toContain("/dashboard/payments/pay");
    expect(hrefs(false)).toContain("/dashboard/payments/deposit");
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

describe("Removed Policies and Approvals navigation", () => {
  it("lists neither Policies nor Approvals, and keeps API Keys", () => {
    const navigation = JSON.stringify(getNavSections(t, navOptions({})));

    expect(navigation).not.toContain("Shared.dashboardShell.policies");
    expect(navigation).not.toContain("Shared.dashboardShell.approvals");
    expect(navigation).toContain("Shared.dashboardShell.apiKeys");
  });
});

describe("subnav open state", () => {
  const closed = { wallets: false, integrations: false, payments: false, markets: false } as const;

  it("opens a section when its top-level item is followed", () => {
    expect(withSubnavOpen(closed, "payments")).toEqual({
      wallets: false,
      integrations: false,
      payments: true,
      markets: false,
    });
  });

  it("never closes the section being navigated into", () => {
    // The whole reason this is not a toggle. A second click on the section you
    // are already inside would otherwise hide the pages you are looking at.
    const open = { wallets: false, integrations: false, payments: true, markets: false };
    expect(withSubnavOpen(open, "payments").payments).toBe(true);
  });

  it("returns the same object when the section is already open", () => {
    // Held in React state, so a click that decides nothing must not re-render
    // the whole shell.
    const open = { wallets: false, integrations: false, payments: true, markets: false };
    expect(withSubnavOpen(open, "payments")).toBe(open);
  });

  it("leaves other sections alone", () => {
    expect(
      withSubnavOpen(
        { wallets: false, integrations: false, payments: false, markets: true },
        "payments"
      )
    ).toEqual({
      wallets: false,
      integrations: false,
      payments: true,
      markets: true,
    });
  });

  it("still flips both ways for the chevron", () => {
    expect(withSubnavToggled(closed, "markets").markets).toBe(true);
    expect(
      withSubnavToggled(
        { wallets: false, integrations: false, payments: false, markets: true },
        "markets"
      ).markets
    ).toBe(false);
  });
});

describe("pinned wallets", () => {
  const pinned = [
    { label: "Off ramp demo wallet", href: "/dashboard/wallets/wa-1", leading: <span /> },
    { label: "KMS", href: "/dashboard/wallets/para-1", leading: <span /> },
  ];
  const walletsItem = (overrides: Partial<Parameters<typeof getNavSections>[1]> = {}) =>
    getNavSections(t, navOptions(overrides))[0]?.items.find(
      (item) => item.href === "/dashboard/wallets"
    );

  it("lists pinned wallets under Wallets as a collapsible group, in pin order", () => {
    const wallets = walletsItem({ walletFavorites: pinned });
    expect(wallets?.subnavKey).toBe("wallets");
    expect(wallets?.children?.map((child) => child.label)).toEqual(["Off ramp demo wallet", "KMS"]);
  });

  it("keeps Wallets a plain link until something is pinned", () => {
    const wallets = walletsItem({ walletFavorites: [] });
    expect(wallets?.children).toBeUndefined();
    expect(wallets?.subnavKey).toBeUndefined();
  });

  it("drops the pins with the Wallets module", () => {
    expect(walletsItem({ custodyEnabled: false, walletFavorites: pinned })).toBeUndefined();
  });
});
