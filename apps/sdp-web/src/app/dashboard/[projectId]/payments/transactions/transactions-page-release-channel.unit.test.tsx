import { SDP_RELEASE_CHANNEL_NAMES } from "@sdp/types/release-channels";
import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types/unified-transactions";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type DashboardDesign, dashboardFlagsAt } from "@/test/release-channel-flags";
import TransactionsPage from "./page";
import { enabledTransactionModules } from "./transaction-modules";

const state = vi.hoisted(() => ({ design: "legacy" as DashboardDesign, flags: {} as unknown }));
const fetchLegacyPage = vi.hoisted(() => vi.fn());
const fetchRedesignPage = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test" }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/flags/dashboard", () => ({ getDashboardFlags: async () => state.flags }));
vi.mock("@/flags/new-design", () => ({
  withLegacyDesign:
    <P extends object>(Current: (props: P) => unknown, Legacy: (props: P) => unknown) =>
    (props: P) =>
      state.design === "redesign" ? Current(props) : Legacy(props),
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ request: vi.fn() }),
  requestProjectHref: async (path: string) => path,
}));
vi.mock("../payments-page.data", () => ({
  fetchIssuedTokensByMint: async () => ({}),
  fetchPaymentsWallets: async () => ({ data: [] }),
}));
vi.mock("../counterparty/counterparty-page.data", () => ({
  fetchCounterparties: async () => ({ data: [] }),
}));
vi.mock("./transactions-page.data", () => ({ fetchTransactionsPage: fetchLegacyPage }));
vi.mock("./transactions-page.data.redesign", () => ({ fetchTransactionsPage: fetchRedesignPage }));

type WorkspaceProps = { modules: string[]; initialFilters: { module?: string } };

async function renderPage(
  releaseChannel: (typeof SDP_RELEASE_CHANNEL_NAMES)[number],
  design: DashboardDesign,
  searchParams: Record<string, string>
): Promise<WorkspaceProps> {
  state.design = design;
  state.flags = dashboardFlagsAt(releaseChannel, design);
  const element = (await TransactionsPage({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement<WorkspaceProps>;
  return element.props;
}

beforeEach(() => {
  const page = { transactions: [], nextCursor: null };
  fetchLegacyPage.mockReset().mockResolvedValue(page);
  fetchRedesignPage.mockReset().mockResolvedValue(page);
});

// Legacy carries the module in `?tab=` (its header tabs), the redesign in `?module=`.
const MODULE_PARAM = { legacy: "tab", redesign: "module" } as const;

const CASES = SDP_RELEASE_CHANNEL_NAMES.flatMap((releaseChannel) =>
  (["legacy", "redesign"] as const).map((design) => ({ releaseChannel, design }))
);

describe("transactions page on each release channel", () => {
  it.each(CASES)(
    "hands the workspace only $releaseChannel's modules on $design",
    async ({ releaseChannel, design }) => {
      const { modules } = await renderPage(releaseChannel, design, {});
      expect(modules).toEqual(enabledTransactionModules(dashboardFlagsAt(releaseChannel)));
    }
  );

  it.each(["legacy", "redesign"] as const)(
    "opens All on stable for a deep link to a module stable hides (%s)",
    async (design) => {
      const fetchPage = design === "legacy" ? fetchLegacyPage : fetchRedesignPage;
      const shown = enabledTransactionModules(dashboardFlagsAt("stable"));
      const hidden = UNIFIED_TRANSACTION_MODULES.filter((module) => !shown.includes(module));
      expect(hidden).not.toEqual([]);
      for (const module of hidden) {
        const { initialFilters } = await renderPage("stable", design, {
          [MODULE_PARAM[design]]: module,
        });
        expect(initialFilters.module, module).toBeUndefined();
        expect(fetchPage).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.not.objectContaining({ module })
        );
      }
    }
  );
});
