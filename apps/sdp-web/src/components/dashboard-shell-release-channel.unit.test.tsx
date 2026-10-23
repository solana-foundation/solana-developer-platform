// @vitest-environment jsdom

import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  SDP_RELEASE_CHANNEL_NAMES,
  type SdpModule,
} from "@sdp/types/release-channels";
import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types/unified-transactions";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enabledTransactionModules } from "@/app/dashboard/[projectId]/payments/transactions/transaction-modules";
import { setDashboardUrl } from "@/test/dashboard-navigation";
import { SANDBOX_PROJECT } from "@/test/projects";
import { DASHBOARD_DESIGNS, dashboardFlagsAt } from "@/test/release-channel-flags";
import { DashboardShell } from "./dashboard-shell";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, orgId: "org-release-channel" }),
  useUser: () => ({ isLoaded: true, isSignedIn: true, user: null }),
  SignInButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => undefined,
  useDashboardWorkspace: () => ({
    dashboardAccess: {
      capabilities: { canReadApprovals: true, canManageOrgSettings: true },
    },
    dashboardCacheScope: { orgId: "org-release-channel", userId: "user-release-channel" },
    selectedProjectId: SANDBOX_PROJECT.id,
    isSidebarOpen: true,
    setSidebarOpen: () => undefined,
    isProjectSwitching: false,
  }),
}));

vi.mock("@/components/workspace-switcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("@/components/sidebar-user-menu", () => ({ SidebarUserMenu: () => null }));
vi.mock("@/components/dashboard-quick-start", () => ({ DashboardQuickStart: () => null }));
vi.mock("@/components/network-debug-panel", () => ({ NetworkDebugPanel: () => null }));
vi.mock("@/components/sentry-user-context", () => ({ SentryUserContext: () => null }));
vi.mock("@/components/language-picker", () => ({ LanguagePicker: () => null }));

const PROJECT = `/dashboard/${SANDBOX_PROJECT.id}`;

/**
 * The navigation link each module owns. A module is listed iff its release channel runs it,
 * checked in both directions so a selector that stopped matching cannot pass as "absent".
 */
const MODULE_LINKS = {
  custody: [`${PROJECT}/wallets`, `${PROJECT}/integrations?tab=custody`],
  payments: [`${PROJECT}/payments`],
  compliance: [`${PROJECT}/integrations?tab=compliance`],
  ramps: [`${PROJECT}/integrations?tab=ramps`],
  issuance: [`${PROJECT}/issuance`],
  markets: [`${PROJECT}/markets`],
  earn: [`${PROJECT}/markets/embedded-yield`],
  dvp: [`${PROJECT}/markets/dvp`],
  private_channels: [`${PROJECT}/integrations?tab=privacy`],
  helius_rings: [`${PROJECT}/helius-rings`],
} as const satisfies Partial<Record<SdpModule, readonly string[]>>;

// Each opens its own subnav, so the sidebar lists that section's children.
const PATHS = [`${PROJECT}/integrations`, `${PROJECT}/markets/treasury-solutions`];

const CASES = SDP_RELEASE_CHANNEL_NAMES.flatMap((releaseChannel) =>
  DASHBOARD_DESIGNS.map((design) => ({ releaseChannel, design }))
);

function sidebarLinks(flags: ReturnType<typeof dashboardFlagsAt>): Set<string> {
  const links = new Set<string>();
  for (const path of PATHS) {
    setDashboardUrl(path, {});
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(
      <DashboardShell flags={flags}>
        <div />
      </DashboardShell>
    );
    for (const anchor of root.querySelectorAll("aside a[href]")) {
      links.add(anchor.getAttribute("href") ?? "");
    }
  }
  return links;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard navigation on each release channel", () => {
  it.each(CASES)(
    "lists only $releaseChannel's modules on $design",
    ({ releaseChannel, design }) => {
      const links = sidebarLinks(dashboardFlagsAt(releaseChannel, design));

      for (const [module, hrefs] of Object.entries(MODULE_LINKS)) {
        const listed = isModuleInReleaseChannel(
          releaseChannel,
          module as SdpModule,
          SDP_RAMP_PROVIDER_STAGES
        );
        for (const href of hrefs) {
          expect(links.has(href), `${module} ${href}`).toBe(listed);
        }
      }
    }
  );

  // The previous design's phone swaps the sidebar for a bottom bar and a More sheet, each
  // wired to the flags by hand.
  const PHONE_LINKS = {
    custody: `${PROJECT}/wallets`,
    payments: `${PROJECT}/payments`,
    issuance: `${PROJECT}/issuance`,
    markets: `${PROJECT}/markets`,
    helius_rings: `${PROJECT}/helius-rings`,
  } as const satisfies Partial<Record<SdpModule, string>>;

  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "lists only %s's modules on the previous design's phone",
    async (releaseChannel) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      // jsdom lays nothing out; the header's tab strip scrolls its active tab into view.
      Element.prototype.scrollIntoView = () => undefined;
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }));
      setDashboardUrl(`${PROJECT}/payments`, {});
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <DashboardShell flags={dashboardFlagsAt(releaseChannel, "legacy")}>
              <div />
            </DashboardShell>
          )
        );
        const bottomNav = container.querySelector("[data-dashboard-bottom-nav]");
        const links = new Set(
          [...(bottomNav?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href"))
        );
        await act(async () => bottomNav?.querySelector<HTMLButtonElement>("button")?.click());
        const sheet = container.querySelector("[data-dashboard-more-sheet]");
        expect(sheet).not.toBeNull();
        for (const anchor of sheet?.querySelectorAll("a[href]") ?? []) {
          links.add(anchor.getAttribute("href"));
        }

        for (const [module, href] of Object.entries(PHONE_LINKS)) {
          const listed = isModuleInReleaseChannel(
            releaseChannel,
            module as SdpModule,
            SDP_RAMP_PROVIDER_STAGES
          );
          expect(links.has(href), module).toBe(listed);
        }
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    }
  );

  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "tabs the previous design's Transactions by %s's modules only",
    (releaseChannel) => {
      // The redesign has no module tabs; its Type filter is covered beside the page.
      const flags = dashboardFlagsAt(releaseChannel, "legacy");
      setDashboardUrl(`${PROJECT}/payments/transactions`, {});
      const text = renderToStaticMarkup(
        <DashboardShell flags={flags}>
          <div />
        </DashboardShell>
      );
      const shown = enabledTransactionModules(flags);
      for (const module of UNIFIED_TRANSACTION_MODULES) {
        expect(text.includes(`DashboardPayments.transactions.modules.${module}`), module).toBe(
          shown.includes(module)
        );
      }
    }
  );
});
