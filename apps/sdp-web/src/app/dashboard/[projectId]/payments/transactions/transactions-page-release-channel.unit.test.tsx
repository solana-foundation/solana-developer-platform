import { SDP_RELEASE_CHANNEL_NAMES, type SdpReleaseChannel } from "@sdp/types/release-channels";
import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LegacyOrRedesignTransactionsPage from "@/app/dashboard/[projectId]/payments/transactions/page";
import { TransactionsPage as RedesignTransactionsPage } from "@/app/dashboard/[projectId]/payments/transactions/page.redesign";
import { enabledTransactionModules } from "@/app/dashboard/[projectId]/payments/transactions/transaction-modules";
import * as flags from "@/flags";
import * as dashboardFlags from "@/flags/dashboard";
import * as sdpApi from "@/lib/sdp-api";
import { type DashboardDesign, dashboardFlagsAt } from "@/test/release-channel-flags";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test" }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

/** What both designs' pages hand their workspace that the release channel decides. */
type WorkspaceProps = {
  modules: UnifiedTransactionModule[];
  initialFilters: { module?: UnifiedTransactionModule };
};

/** The API paths the page read, so a test can see which module it asked for. */
const requestedPaths: string[] = [];

/** Each read the two pages make, answered as the API answers an empty Project. */
const EMPTY_PROJECT_ANSWERS: Record<string, unknown> = {
  "/v1/issuance/tokens?page=1&pageSize=100": { data: { tokens: [] }, meta: { hasMore: false } },
  "/v1/wallets?view=summary": { data: { wallets: [] } },
  "/v1/counterparties?page=1&pageSize=100": { data: { counterparties: [], total: 0 } },
};

/** Reads no answer covers; the page's readers swallow the throw, so each test checks this. */
const unexpectedPaths: string[] = [];

/**
 * Answers the reads the page makes for an empty Project, recording each path. Any other read
 * throws and is recorded, so a page that starts reading something new fails the test.
 */
function emptyApiClient(): sdpApi.SdpApiClient {
  const body = (path: string) => {
    if (path.startsWith("/v1/transactions?")) return { transactions: [], nextCursor: null };
    if (!(path in EMPTY_PROJECT_ANSWERS)) {
      unexpectedPaths.push(path);
      throw new Error(`Unexpected request: ${path}`);
    }
    return EMPTY_PROJECT_ANSWERS[path];
  };
  return {
    request: async (path: string) => {
      requestedPaths.push(path);
      return Response.json(body(path));
    },
    fetch: async <T,>(path: string): Promise<T> => {
      requestedPaths.push(path);
      // SAFETY: each empty body matches the response type its reader declares for that path.
      return body(path) as T;
    },
  };
}

async function renderPage(
  releaseChannel: SdpReleaseChannel,
  design: DashboardDesign,
  searchParams: Record<string, string>
): Promise<WorkspaceProps> {
  vi.spyOn(dashboardFlags, "getDashboardFlags").mockResolvedValue(
    dashboardFlagsAt(releaseChannel, design)
  );
  // The legacy route picks its design by NEW DESIGN; the redesign is rendered directly.
  vi.spyOn(flags, "newDesign").mockResolvedValue(false);
  const page = design === "redesign" ? RedesignTransactionsPage : LegacyOrRedesignTransactionsPage;
  // SAFETY: both pages return their workspace element, whose props include `WorkspaceProps`.
  const element = (await page({
    searchParams: Promise.resolve(searchParams),
  })) as ReactElement<WorkspaceProps>;
  return element.props;
}

beforeEach(() => {
  requestedPaths.length = 0;
  unexpectedPaths.length = 0;
  vi.spyOn(sdpApi, "createSdpApiClient").mockImplementation(async () => emptyApiClient());
});

afterEach(() => {
  expect(unexpectedPaths).toEqual([]);
  vi.restoreAllMocks();
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
      const shown = enabledTransactionModules(dashboardFlagsAt("stable"));
      const hidden = UNIFIED_TRANSACTION_MODULES.filter((module) => !shown.includes(module));
      expect(hidden).not.toEqual([]);
      for (const module of hidden) {
        requestedPaths.length = 0;
        const { initialFilters } = await renderPage("stable", design, {
          [MODULE_PARAM[design]]: module,
        });
        expect(initialFilters.module, module).toBeUndefined();
        const transactionsRead = requestedPaths.filter((path) =>
          path.startsWith("/v1/transactions")
        );
        expect(transactionsRead, module).toHaveLength(1);
        expect(transactionsRead[0], module).not.toContain(`module=${module}`);
      }
    }
  );
});
