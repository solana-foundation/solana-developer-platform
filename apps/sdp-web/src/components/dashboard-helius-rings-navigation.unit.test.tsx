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

import { DashboardMoreSheet } from "./dashboard-more-sheet";
import { getNavSections } from "./dashboard-nav";

type Translate = Parameters<typeof getNavSections>[0];
const t = ((key: string) => key) as Translate;

function navOptions(overrides: Partial<Parameters<typeof getNavSections>[1]> = {}) {
  return {
    canReadApprovals: false,
    earnEnabled: false,
    heliusRingsEnabled: false,
    marketsEnabled: false,
    pendingApprovalCount: null,
    privateChannelsEnabled: false,
    ...overrides,
  };
}

function findHeliusRingsItem(options: ReturnType<typeof navOptions>) {
  return getNavSections(t, options)
    .find((section) => section.title === "Shared.dashboardShell.manage")
    ?.items.find((item) => item.label === "Shared.dashboardShell.heliusRings");
}

describe("Helius Rings dashboard navigation", () => {
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
    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard"
        canReadApprovals={false}
        canManageOrgSettings={false}
        earnEnabled={false}
        heliusRingsEnabled
        marketsEnabled={false}
        onClose={() => {}}
      />
    );

    expect(markup).toContain('href="/dashboard/helius-rings"');
    expect(markup).toContain("Shared.dashboardShell.heliusRings");
  });

  it("keeps the entry out of the mobile More sheet when the flag is off", () => {
    const markup = renderToStaticMarkup(
      <DashboardMoreSheet
        pathname="/dashboard"
        canReadApprovals={false}
        canManageOrgSettings={false}
        earnEnabled={false}
        heliusRingsEnabled={false}
        marketsEnabled={false}
        onClose={() => {}}
      />
    );

    expect(markup).not.toContain("/dashboard/helius-rings");
  });
});
