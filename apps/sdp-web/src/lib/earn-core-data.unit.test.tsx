// @vitest-environment jsdom
import type { Operation } from "@sdp/types/operations";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, expect, it, vi } from "vitest";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { DASHBOARD_SWR_CONFIG } from "./dashboard-swr-config";
import { type EarnOperationsFeed, useEarnOperation, useEarnOperations } from "./earn-core-data";

const transport = vi.hoisted(() => vi.fn());
vi.mock("./dashboard-fetch", () => ({ dashboardRequest: transport }));

const prepared: Operation = {
  id: "operation",
  kind: "earn.deposit",
  status: "prepared",
  environment: "sandbox",
  intent: {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { walletId: "wallet" },
    amount: { mint: "usdc", value: "10" },
  },
  actionId: "action",
  version: 1,
  nextAction: { type: "submit" },
  terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
  buildRef: null,
  resourceRef: null,
  result: null,
  canCancel: false,
  cancelRequestedAt: null,
  error: null,
  createdAt: "2026-11-18T12:00:00.000Z",
  updatedAt: "2026-11-18T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("reports changed remote observations once without echoing initial render data", async () => {
  let remote: Operation = {
    ...prepared,
    status: "queued",
    nextAction: { type: "wait", reason: "Queued" },
    updatedAt: "2026-11-18T12:01:00.000Z",
  };
  transport.mockImplementation(async () => Response.json({ data: { operation: remote } }));
  const onUpdated = vi.fn();
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
  );
  const { result } = renderHook(() => useEarnOperation(prepared.id, prepared, onUpdated), {
    wrapper,
  });
  expect(onUpdated).not.toHaveBeenCalled();
  await waitFor(() => expect(result.current.operation?.status).toBe("queued"));
  expect(onUpdated).toHaveBeenCalledExactlyOnceWith(remote);

  remote = {
    ...remote,
    status: "awaiting_signature",
    updatedAt: "2026-11-18T12:02:00.000Z",
  };
  await act(() => result.current.refresh());
  expect(onUpdated).toHaveBeenCalledTimes(2);
  expect(onUpdated).toHaveBeenLastCalledWith(remote);
  await act(() => result.current.refresh());
  expect(onUpdated).toHaveBeenCalledTimes(2);
});

function historyOperation(id: string, status: Operation["status"] = "completed"): Operation {
  return {
    ...prepared,
    id,
    status,
    nextAction: status === "completed" ? null : { type: "wait", reason: "Waiting" },
    createdAt: id.startsWith("old") ? "2026-11-17T00:00:00Z" : "2026-11-23T00:00:00Z",
  };
}

function page(operations: Operation[], nextCursor: string | null = null) {
  return Response.json({ data: { operations, nextCursor } });
}

function deferred<Value>() {
  let finish: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    finish = resolve;
  });
  return { promise, resolve: (value: Value) => finish?.(value) };
}

function renderFeed() {
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, errorRetryCount: 0 }}>
      {children}
    </SWRConfig>
  );
  return renderHook(
    () => {
      const feed = useEarnOperations();
      const { mutate } = useSWRConfig();
      return {
        ...feed,
        poll: () => mutate(earnQueryKeys.operations()),
        observe: (operation: Operation) =>
          mutate<EarnOperationsFeed>(
            earnQueryKeys.operations(),
            (current) =>
              current
                ? {
                    ...current,
                    operations: current.operations.map((candidate) =>
                      candidate.id === operation.id ? operation : candidate
                    ),
                  }
                : current,
            { revalidate: false }
          ),
      };
    },
    { wrapper }
  );
}

it("polls all active work and only one recent history page", async () => {
  const history = Array.from({ length: 50 }, (_, index) => historyOperation(`history-${index}`));
  transport.mockImplementation(async (path: string) => {
    const query = new URL(path, "https://dashboard.test").searchParams;
    return query.get("status") === "active" ? page([]) : page(history, "older-history");
  });
  const { result } = renderFeed();
  await waitFor(() => expect(result.current.operations).toHaveLength(50));
  expect(transport).toHaveBeenCalledTimes(2);
  expect(
    transport.mock.calls.map(([path]) => new URL(path, "https://dashboard.test").search)
  ).toEqual(expect.arrayContaining(["?status=active&limit=100", "?limit=50"]));
  await act(() => result.current.poll());
  expect(transport).toHaveBeenCalledTimes(4);
  expect(transport.mock.calls.every(([path]) => !String(path).includes("cursor="))).toBe(true);
});

it("keeps an old pending exit mounted when it disappears outside recent history", async () => {
  const pending = historyOperation("old-pending", "settling");
  let active = [pending];
  transport.mockImplementation(async (path: string) =>
    new URL(path, "https://dashboard.test").searchParams.get("status") === "active"
      ? page(active)
      : page([historyOperation("recent")])
  );
  const { result } = renderFeed();
  await waitFor(() =>
    expect(result.current.operations?.some(({ id }) => id === pending.id)).toBe(true)
  );
  active = [];
  await act(() => result.current.poll());
  expect(result.current.operations?.find(({ id }) => id === pending.id)?.status).toBe("settling");
  await act(() => result.current.observe(historyOperation(pending.id)));
  expect(result.current.operations?.find(({ id }) => id === pending.id)?.status).toBe("completed");
  await act(() => result.current.poll());
  expect(result.current.operations?.some(({ id }) => id === pending.id)).toBe(false);
});

it("retains all active pages and identifies a projected terminal observation", async () => {
  const projected = historyOperation("old-just-completed");
  transport.mockImplementation(async (path: string) => {
    const query = new URL(path, "https://dashboard.test").searchParams;
    if (query.get("status") !== "active") return page([]);
    return query.has("cursor")
      ? page([projected])
      : page([historyOperation("waiting", "settling")], "active-next");
  });
  const { result } = renderFeed();
  await waitFor(() => expect(result.current.operations).toHaveLength(2));
  expect(result.current.activeIds).toContain(projected.id);
  expect(transport.mock.calls.some(([path]) => String(path).includes("cursor=active-next"))).toBe(
    true
  );
});

it("freezes expanded history before More and refuses a late poll's replacement snapshot", async () => {
  const latePoll = deferred<Response>();
  const older = deferred<Response>();
  let historyReads = 0;
  transport.mockImplementation(async (path: string) => {
    const query = new URL(path, "https://dashboard.test").searchParams;
    if (query.get("status") === "active") return page([]);
    if (query.has("cursor")) return older.promise;
    historyReads += 1;
    return historyReads === 1 ? page([historyOperation("recent")], "history-2") : latePoll.promise;
  });
  const { result } = renderFeed();
  await waitFor(() => expect(result.current.hasMore).toBe(true));
  let polling: Promise<unknown> | undefined;
  act(() => {
    polling = result.current.poll();
  });
  await waitFor(() => expect(historyReads).toBe(2));
  let loading: Promise<void> | undefined;
  act(() => {
    loading = result.current.loadMore();
  });
  await waitFor(() =>
    expect(transport.mock.calls.some(([path]) => String(path).includes("cursor=history-2"))).toBe(
      true
    )
  );
  await act(async () => {
    older.resolve(page([historyOperation("old-history")], "history-3"));
    await loading;
  });
  expect(result.current.operations?.map(({ id }) => id)).toContain("old-history");
  await act(async () => {
    latePoll.resolve(page([historyOperation("late-poll")], "wrong-cursor"));
    await polling;
  });
  expect(result.current.operations?.map(({ id }) => id)).toContain("old-history");
  expect(result.current.operations?.map(({ id }) => id)).not.toContain("late-poll");
  const before = transport.mock.calls.length;
  await act(() => result.current.poll());
  expect(transport.mock.calls).toHaveLength(before + 1);
  expect(String(transport.mock.calls.at(-1)?.[0])).toContain("status=active");
});

it("keeps existing history visible when a background read fails", async () => {
  let failed = false;
  transport.mockImplementation(async (path: string) => {
    if (failed)
      return Response.json(
        { error: { code: "PROVIDER_UNAVAILABLE", message: "Unavailable" } },
        { status: 503 }
      );
    return new URL(path, "https://dashboard.test").searchParams.has("status")
      ? page([])
      : page([historyOperation("visible")]);
  });
  const { result } = renderFeed();
  await waitFor(() => expect(result.current.operations).toHaveLength(1));
  failed = true;
  await act(() => result.current.poll());
  expect(result.current.error).toBeDefined();
  expect(result.current.operations?.[0]?.id).toBe("visible");
});

it("does not expose a late response after switching the project cache scope", async () => {
  const first = deferred<Response>();
  let scope = "first";
  const caches = { first: new Map(), second: new Map() };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig
      key={scope}
      value={{
        provider: () => (scope === "first" ? caches.first : caches.second),
        dedupingInterval: 0,
        errorRetryCount: 0,
      }}
    >
      {children}
    </SWRConfig>
  );
  transport.mockImplementation(async (path: string) => {
    if (new URL(path, "https://dashboard.test").searchParams.has("status")) return page([]);
    return scope === "first" ? first.promise : page([historyOperation("second-project")]);
  });
  const { result, rerender } = renderHook(() => useEarnOperations(), { wrapper });
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  scope = "second";
  rerender();
  await waitFor(() => expect(result.current.operations?.[0]?.id).toBe("second-project"));
  await act(async () => {
    first.resolve(page([historyOperation("first-project")]));
    await first.promise;
  });
  expect(result.current.operations?.map(({ id }) => id)).toEqual(["second-project"]);
});

it("keeps detail polling on time while unrelated workspace renders continue", async () => {
  vi.useFakeTimers();
  transport.mockImplementation(async () => Response.json({ data: { operation: prepared } }));
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
  );
  const { rerender } = renderHook(() => useEarnOperation(prepared.id, prepared), { wrapper });
  for (let tick = 0; tick < 5; tick += 1) {
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    rerender();
  }
  expect(transport.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it("polls an active operation every two seconds under the dashboard's SWR defaults", async () => {
  vi.useFakeTimers();
  transport.mockImplementation(async () => Response.json({ data: { operation: prepared } }));
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ ...DASHBOARD_SWR_CONFIG, provider: () => cache }}>{children}</SWRConfig>
  );
  renderHook(() => useEarnOperation(prepared.id, prepared), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(6_500));
  expect(transport.mock.calls.length).toBeGreaterThanOrEqual(4);
});

it("refreshes an expanded history snapshot without blanking the rows being read", async () => {
  const refreshed = deferred<Response>();
  let historyReads = 0;
  transport.mockImplementation(async (path: string) => {
    const query = new URL(path, "https://dashboard.test").searchParams;
    if (query.has("status")) return page([]);
    if (query.has("cursor")) return page([historyOperation("old-history")]);
    historyReads += 1;
    return historyReads === 1 ? page([historyOperation("recent")], "history-2") : refreshed.promise;
  });
  const { result } = renderFeed();
  await waitFor(() => expect(result.current.hasMore).toBe(true));
  await act(() => result.current.loadMore());
  expect(result.current.operations?.map(({ id }) => id)).toContain("old-history");
  let refreshing: Promise<unknown> | undefined;
  act(() => {
    refreshing = result.current.refresh();
  });
  await waitFor(() => expect(historyReads).toBe(2));
  expect(result.current.operations?.map(({ id }) => id)).toContain("old-history");
  await act(async () => {
    refreshed.resolve(page([historyOperation("latest")], "latest-cursor"));
    await refreshing;
  });
  expect(result.current.operations?.map(({ id }) => id)).toEqual(["latest"]);
  expect(result.current.hasMore).toBe(true);
});

function OperationObserver({ onUpdated }: { onUpdated: (operation: Operation) => void }) {
  useEarnOperation(prepared.id, prepared, onUpdated);
  return null;
}

it("reports a shared detail result after its original dialog has closed", async () => {
  const pending = deferred<Response>();
  transport.mockReturnValue(pending.promise);
  const cache = new Map();
  const first = vi.fn();
  const remaining = vi.fn();
  const view = (dialogOpen: boolean) => (
    <SWRConfig value={{ provider: () => cache }}>
      {dialogOpen ? <OperationObserver key="dialog" onUpdated={first} /> : null}
      <OperationObserver key="activity" onUpdated={remaining} />
    </SWRConfig>
  );
  const rendered = render(view(true));
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  rendered.rerender(view(false));
  const completed = historyOperation(prepared.id);
  await act(async () => {
    pending.resolve(Response.json({ data: { operation: completed } }));
    await pending.promise;
  });
  await waitFor(() => expect(remaining).toHaveBeenCalledExactlyOnceWith(completed));
  expect(first).not.toHaveBeenCalled();
});

it("never lets a stale same-version detail cache reopen a terminal parent observation", async () => {
  transport.mockImplementation(async () => Response.json({ data: { operation: prepared } }));
  const cache = new Map();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>
  );
  const { result, rerender } = renderHook(
    ({ initial }: { initial: Operation }) => useEarnOperation(initial.id, initial),
    { wrapper, initialProps: { initial: prepared } }
  );
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  const completed = { ...historyOperation(prepared.id), updatedAt: "2026-11-18T11:00:00Z" };
  rerender({ initial: completed });
  expect(result.current.operation?.status).toBe("completed");
  await act(() => result.current.refresh());
  expect(result.current.operation?.status).toBe("completed");
});
