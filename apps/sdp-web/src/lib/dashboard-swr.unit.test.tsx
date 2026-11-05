// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import {
  dashboardDataResponse,
  sentDashboardReads,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import {
  type DashboardKeyScope,
  dashboardPostReadKey,
  dashboardRequestKey,
  readsUnderPath,
} from "./dashboard-request-key";
import {
  DashboardReadError,
  readDashboardPostRequest,
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
  useInvalidateDashboardReads,
} from "./dashboard-swr";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const WALLETS_KEY = dashboardRequestKey(SCOPE, "/api/dashboard/wallets");
const COUNTERPARTIES_KEY = dashboardRequestKey(SCOPE, "/api/dashboard/counterparty");
const LABEL_KEY = ["wallet-activity", "wal_test_1"] as const;
const amountSchema = z.object({ data: z.object({ amount: z.number() }) });

function readsOf(fetchMock: Mock<typeof fetch>, path: string): number {
  return sentDashboardReads(fetchMock).filter((read) => read.path === path).length;
}

function stubCountingReads(): Mock<typeof fetch> {
  const fetchMock = stubDashboardFetch(({ path }) =>
    dashboardDataResponse(200, { amount: readsOf(fetchMock, path) })
  );
  return fetchMock;
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("useDashboardRead", () => {
  it.each([
    ["live", null],
    ["demo", "1"],
  ] as const)("sends a %s read under the key's Project, not the tab's URL", async (mode, demo) => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/wallets`);
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, { amount: 7 }));
    const key = dashboardRequestKey(
      { projectId: SANDBOX_PROJECT.id, mode },
      "/api/dashboard/wallets",
      {
        view: "summary",
      }
    );

    const { result } = renderHook(() => useDashboardRead(key, amountSchema), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.data).toEqual({ data: { amount: 7 } }));
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: "/api/dashboard/wallets?view=summary", projectId: SANDBOX_PROJECT.id, demo },
    ]);
  });

  it.each([
    [
      Response.json({ error: { code: "FORBIDDEN", message: "No access" } }, { status: 403 }),
      { status: 403, code: "FORBIDDEN", message: "No access" },
    ],
    [
      Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 }),
      { status: 403, code: "FORBIDDEN", message: "" },
    ],
    [new Response("<html></html>", { status: 502 }), { status: 502, code: null, message: "" }],
  ])(
    "fails a refused read with its status, code and the API's own message",
    async (answer, expected) => {
      stubDashboardFetch(() => answer);

      const read = readDashboardRequest(WALLETS_KEY, amountSchema);

      await expect(read).rejects.toBeInstanceOf(DashboardReadError);
      await expect(read).rejects.toMatchObject(expected);
    }
  );

  it.each([
    ["a body its schema rejects", () => dashboardDataResponse(200, { amount: "7" })],
    ["a body that is not JSON", () => new Response("<html></html>", { status: 200 })],
  ])("fails a read answered with %s, with no code", async (_case, answer) => {
    stubDashboardFetch(answer);

    const { result } = renderHook(() => useDashboardRead(WALLETS_KEY, amountSchema), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(DashboardReadError));
    expect(result.current.error).toMatchObject({ status: 200, code: null });
    expect(result.current.data).toBeUndefined();
  });
});

describe("readDashboardPostRequest", () => {
  const ESTIMATE_PATH = "/api/dashboard/payments/ramps/onramp/estimate";
  const ESTIMATE_PARAMS = { amount: "25.00", fiatCurrency: "USD" };
  const BATCH_ESTIMATE_PATH = "/api/dashboard/payments/transfers/batch/estimate";

  it.each([
    ["live", null],
    ["demo", "1"],
  ] as const)("posts a %s read's params under the key's Project, unkeyed", async (mode, demo) => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/payments`);
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, { amount: 7 }));
    const key = dashboardPostReadKey(
      { projectId: SANDBOX_PROJECT.id, mode },
      ESTIMATE_PATH,
      ESTIMATE_PARAMS
    );

    await expect(readDashboardPostRequest(key, amountSchema)).resolves.toEqual({
      data: { amount: 7 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      ESTIMATE_PATH,
      expect.objectContaining({ body: key[3].body })
    );
    expect(sentDashboardRequests(fetchMock)).toEqual([
      { path: ESTIMATE_PATH, method: "POST", idempotencyKey: null, body: ESTIMATE_PARAMS },
    ]);
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: ESTIMATE_PATH, projectId: SANDBOX_PROJECT.id, demo },
    ]);
  });

  it("posts a nested body verbatim", async () => {
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, { amount: 7 }));
    const body = {
      recipients: [
        { address: "addr_test_1", amount: "1.5" },
        { address: "addr_test_2", amount: "2" },
      ],
      memo: null,
    };
    const key = dashboardPostReadKey(SCOPE, BATCH_ESTIMATE_PATH, body);

    await readDashboardPostRequest(key, amountSchema);

    expect(fetchMock).toHaveBeenCalledWith(
      BATCH_ESTIMATE_PATH,
      expect.objectContaining({ body: key[3].body })
    );
    expect(sentDashboardRequests(fetchMock)).toEqual([
      { path: BATCH_ESTIMATE_PATH, method: "POST", idempotencyKey: null, body },
    ]);
  });

  it("fails a refused read like a GET read", async () => {
    stubDashboardFetch(() =>
      Response.json({ error: { code: "VALIDATION_ERROR", message: "Too small" } }, { status: 422 })
    );
    const key = dashboardPostReadKey(SCOPE, ESTIMATE_PATH, ESTIMATE_PARAMS);

    const read = readDashboardPostRequest(key, amountSchema);

    await expect(read).rejects.toBeInstanceOf(DashboardReadError);
    await expect(read).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Too small",
    });
  });
});

describe("useDashboardKeyScope", () => {
  it.each([
    [true, "demo"],
    [false, "live"],
  ] as const)("scopes keys to the URL's Project, demo %s reading as %s", (demo, mode) => {
    const { result } = renderHook(() => useDashboardKeyScope(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PaymentsDemoProvider value={demo}>{children}</PaymentsDemoProvider>
      ),
    });

    expect(result.current).toEqual({ projectId: SANDBOX_PROJECT.id, mode });
  });
});

function useReads({ walletsMounted }: { walletsMounted: boolean }) {
  return {
    invalidate: useInvalidateDashboardReads(),
    wallets: useDashboardRead(walletsMounted ? WALLETS_KEY : null, amountSchema),
    counterparties: useDashboardRead(COUNTERPARTIES_KEY, amountSchema),
  };
}

function useSharedKeyReads({
  secondMounted,
  fetcher,
}: {
  secondMounted: boolean;
  fetcher: () => Promise<string>;
}) {
  return {
    invalidate: useInvalidateDashboardReads(),
    first: useDashboardSWR(WALLETS_KEY, fetcher),
    second: useDashboardSWR(secondMounted ? WALLETS_KEY : null, fetcher),
  };
}

function useOffScreenRead({
  mounted,
  fetcher,
}: {
  mounted: boolean;
  fetcher: () => Promise<string>;
}) {
  return {
    invalidate: useInvalidateDashboardReads(),
    read: useDashboardSWR(mounted ? WALLETS_KEY : null, fetcher),
  };
}

describe("useInvalidateDashboardReads", () => {
  it("refetches a mounted matching read without blanking it, and leaves the others alone", async () => {
    const fetchMock = stubCountingReads();
    const shown: unknown[] = [];
    const { result } = renderHook(
      (props: { walletsMounted: boolean }) => {
        const reads = useReads(props);
        shown.push(reads.wallets.data);
        return reads;
      },
      { wrapper: DashboardReadsProvider, initialProps: { walletsMounted: true } }
    );
    await waitFor(() => expect(result.current.counterparties.data).toBeDefined());
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 1 } }));
    const shownBeforeInvalidation = shown.length;

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));

    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 2 } }));
    expect(shown.slice(shownBeforeInvalidation)).not.toContain(undefined);
    expect(readsOf(fetchMock, "/api/dashboard/counterparty")).toBe(1);
    expect(result.current.counterparties.data).toEqual({ data: { amount: 1 } });
  });

  it("clears an unmounted matching read, so mounting it again shows loading", async () => {
    stubCountingReads();
    const { result, rerender } = renderHook(useReads, {
      wrapper: DashboardReadsProvider,
      initialProps: { walletsMounted: true },
    });
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 1 } }));
    rerender({ walletsMounted: false });

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));
    rerender({ walletsMounted: true });

    expect(result.current.wallets.data).toBeUndefined();
    expect(result.current.wallets.isLoading).toBe(true);
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 2 } }));
  });

  it("remounts a read cleared mid-request into its own request, never the older answer", async () => {
    const stale = Promise.withResolvers<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce("fresh");
    const shown: unknown[] = [];
    const { result, rerender } = renderHook(
      (props: { mounted: boolean; fetcher: () => Promise<string> }) => {
        const reads = useOffScreenRead(props);
        shown.push(reads.read.data);
        return reads;
      },
      { wrapper: DashboardReadsProvider, initialProps: { mounted: true, fetcher } }
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ mounted: false, fetcher });

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));
    rerender({ mounted: true, fetcher });

    expect(result.current.read.data).toBeUndefined();
    expect(result.current.read.isLoading).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.read.data).toBe("fresh"));
    stale.resolve("stale");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(result.current.read.data).toBe("fresh");
    expect(shown).not.toContain("stale");
  });

  it("keeps a read on screen while another component reading the same key unmounts", async () => {
    let answer = "before";
    const fetcher = vi.fn(async () => answer);
    const shown: unknown[] = [];
    const { result, rerender } = renderHook(
      (props: { secondMounted: boolean; fetcher: () => Promise<string> }) => {
        const reads = useSharedKeyReads(props);
        shown.push(reads.first.data);
        return reads;
      },
      { wrapper: DashboardReadsProvider, initialProps: { secondMounted: true, fetcher } }
    );
    await waitFor(() => expect(result.current.second.data).toBe("before"));
    rerender({ secondMounted: false, fetcher });
    const shownBeforeInvalidation = shown.length;
    answer = "after";

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));

    await waitFor(() => expect(result.current.first.data).toBe("after"));
    expect(shown.slice(shownBeforeInvalidation)).not.toContain(undefined);
  });

  it("never touches a key that is not a request key, whatever the predicate matches", async () => {
    const walletsFetcher = vi.fn(async () => "wallets");
    const labelFetcher = vi.fn(async () => "label");
    const { result } = renderHook(
      () => ({
        invalidate: useInvalidateDashboardReads(),
        wallets: useDashboardSWR(WALLETS_KEY, walletsFetcher),
        label: useSWR(LABEL_KEY, labelFetcher),
      }),
      { wrapper: DashboardReadsProvider }
    );
    await waitFor(() => {
      expect(result.current.wallets.data).toBe("wallets");
      expect(result.current.label.data).toBe("label");
    });

    await act(() => result.current.invalidate(() => true));

    await waitFor(() => expect(walletsFetcher).toHaveBeenCalledTimes(2));
    expect(labelFetcher).toHaveBeenCalledTimes(1);
    expect(result.current.label.data).toBe("label");
  });
});
