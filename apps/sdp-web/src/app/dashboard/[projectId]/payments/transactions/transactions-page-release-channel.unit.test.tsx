import { SDP_RELEASE_CHANNEL_NAMES, type SdpReleaseChannel } from "@sdp/types/release-channels";
import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TransactionsPage from "@/app/dashboard/[projectId]/payments/transactions/page";
import { enabledTransactionModules } from "@/app/dashboard/[projectId]/payments/transactions/transaction-modules";
import * as dashboardFlags from "@/flags/dashboard";
import * as sdpApi from "@/lib/sdp-api";
import { dashboardFlagsAt } from "@/test/release-channel-flags";

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_test", orgId: "org_test" }),
}));
vi.mock("next/navigation", () => import("@/test/next-navigation"));

/** What the page hands its workspace that the release channel decides. */
type WorkspaceProps = {
  modules: UnifiedTransactionModule[];
  initialFilters: { module?: UnifiedTransactionModule };
};

/** The API paths the page read, so a test can see which module it asked for. */
const requestedPaths: string[] = [];

/** Each read the page makes, answered as the API answers an empty Project. */
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
  searchParams: Record<string, string>
): Promise<WorkspaceProps> {
  vi.spyOn(dashboardFlags, "getDashboardFlags").mockResolvedValue(dashboardFlagsAt(releaseChannel));
  // SAFETY: the page returns its workspace element, whose props include `WorkspaceProps`.
  const element = (await TransactionsPage({
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

describe("transactions page on each release channel", () => {
  it.each(SDP_RELEASE_CHANNEL_NAMES)(
    "hands the workspace only %s's modules",
    async (releaseChannel) => {
      const { modules } = await renderPage(releaseChannel, {});
      expect(modules).toEqual(enabledTransactionModules(dashboardFlagsAt(releaseChannel)));
    }
  );

  it("opens All on stable for a deep link to a module stable hides", async () => {
    const shown = enabledTransactionModules(dashboardFlagsAt("stable"));
    const hidden = UNIFIED_TRANSACTION_MODULES.filter((module) => !shown.includes(module));
    expect(hidden).not.toEqual([]);
    for (const module of hidden) {
      requestedPaths.length = 0;
      const { initialFilters } = await renderPage("stable", { module });
      expect(initialFilters.module, module).toBeUndefined();
      const transactionsRead = requestedPaths.filter((path) => path.startsWith("/v1/transactions"));
      expect(transactionsRead, module).toHaveLength(1);
      expect(transactionsRead[0], module).not.toContain(`module=${module}`);
    }
  });
});
