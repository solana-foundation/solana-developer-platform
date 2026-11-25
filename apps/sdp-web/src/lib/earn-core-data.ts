"use client";

import { isTerminalOperationStatus, type Operation } from "@sdp/types/operations";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { dashboardRequest } from "./dashboard-fetch";
import { createEarnClient } from "./earn-client";
import { EarnOperationObserver } from "./earn-operation-observer";

/** Both Earn products use the same project-scoped transport and typed contract. */
export const earnCoreClient = createEarnClient((path, init) => {
  let dashboardPath: string;
  if (path.startsWith("/v1/earn/")) {
    dashboardPath = path.replace("/v1/earn/", "/api/dashboard/markets/earn/");
  } else if (
    path === "/v1/operations" ||
    path.startsWith("/v1/operations?") ||
    path.startsWith("/v1/operations/")
  ) {
    dashboardPath = path.replace("/v1/operations", "/api/dashboard/operations");
  } else {
    throw new Error("Unsupported Earn client path");
  }
  return dashboardRequest(dashboardPath, init ?? {});
});

/** Settlement, rejection and confirmed cancellation stop active operation polling. */
export function isEarnOperationTerminal(operation: Operation): boolean {
  return isTerminalOperationStatus(operation.status);
}

const OPERATIONS_HISTORY_PAGE_SIZE = 50;

/** One cache owns live work and the history snapshot the user is reading. */
export interface EarnOperationsFeed {
  operations: Operation[];
  activeIds: string[];
  nextCursor: string | null;
  expanded: boolean;
}

/** Keep the strongest server observation when list and detail reads overlap. */
function preferredObservation(previous: Operation | undefined, incoming: Operation): Operation {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (previous.version !== incoming.version)
    return previous.version > incoming.version ? previous : incoming;
  const previousTerminal = isEarnOperationTerminal(previous);
  const incomingTerminal = isEarnOperationTerminal(incoming);
  if (previousTerminal !== incomingTerminal) return previousTerminal ? previous : incoming;
  return Date.parse(previous.updatedAt) > Date.parse(incoming.updatedAt) ? previous : incoming;
}

function currentObservation(
  id: string | undefined,
  initial: Operation | undefined,
  observed: Operation | undefined
): Operation | undefined {
  const fallback = initial?.id === id ? initial : undefined;
  return observed && observed.id === id ? preferredObservation(fallback, observed) : fallback;
}

function mergeOperations(...groups: readonly (readonly Operation[])[]): Operation[] {
  const byId = new Map<string, Operation>();
  for (const group of groups) {
    for (const operation of group)
      byId.set(operation.id, preferredObservation(byId.get(operation.id), operation));
  }
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)
  );
}

/** Walk only active work; terminal history is one explicit page at a time. */
async function fetchActiveOperations(): Promise<Operation[]> {
  const operations: Operation[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await earnCoreClient.operations({ status: "active", limit: 100, cursor });
    operations.push(...result.operations);
    if (result.nextCursor === null) return operations;
    if (seen.has(result.nextCursor)) throw new Error("Earn operation pagination did not advance");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Earn operation pagination exceeded its safety limit");
}

interface ProgressObservation {
  error?: Error;
}

const operationObservers = new WeakMap<
  ReturnType<typeof useSWRConfig>["cache"],
  EarnOperationObserver
>();

function operationObserver({ cache, mutate }: ReturnType<typeof useSWRConfig>) {
  const existing = operationObservers.get(cache);
  if (existing) return existing;
  const observer = new EarnOperationObserver({
    visible: () => !document.hidden,
    read: async (ids) => {
      const page = await earnCoreClient.operations(
        { operationIds: ids.join(","), limit: 100 },
        AbortSignal.timeout(10_000)
      );
      if (page.nextCursor !== null) throw new Error("Incomplete operation observation");
      return page.operations;
    },
    publish: async (operations) => {
      await Promise.all(
        operations.map((operation) =>
          mutate<Operation>(
            earnQueryKeys.operation(operation.id),
            (current) => preferredObservation(current, operation),
            { revalidate: false }
          )
        )
      );
      await mutate<EarnOperationsFeed>(
        earnQueryKeys.operations(),
        (current) =>
          current
            ? {
                ...current,
                operations: mergeOperations(current.operations, operations),
              }
            : current,
        { revalidate: false }
      );
    },
    reportError: async (error) => {
      await mutate<ProgressObservation>(
        earnQueryKeys.operationProgress(),
        { error },
        {
          revalidate: false,
        }
      );
    },
  });
  operationObservers.set(cache, observer);
  return observer;
}

/** Recover every active operation while keeping automatic history reads bounded. */
export function useEarnOperations() {
  const config = useSWRConfig();
  const { cache } = config;
  const observer = operationObserver(config);
  useEffect(() => observer.retain(), [observer]);
  const { data: progress } = useSWR<ProgressObservation>(earnQueryKeys.operationProgress(), null);
  const key = earnQueryKeys.operations();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error>();
  // This private key is written only with the typed feed below or the action callback.
  const currentFeed = () => cache.get(key)?.data as EarnOperationsFeed | undefined;
  async function readFeed(): Promise<EarnOperationsFeed> {
    const expanded = currentFeed()?.expanded === true;
    const [active, recent] = await Promise.all([
      fetchActiveOperations(),
      expanded ? undefined : earnCoreClient.operations({ limit: OPERATIONS_HISTORY_PAGE_SIZE }),
    ]);
    const previous = currentFeed();
    await config.mutate<ProgressObservation>(
      earnQueryKeys.operationProgress(),
      { error: undefined },
      { revalidate: false }
    );
    for (const operation of mergeOperations(
      previous?.operations ?? [],
      recent?.operations ?? [],
      active
    ))
      observer.observe(operation);
    const observedIds = new Set([...active, ...(recent?.operations ?? [])].map(({ id }) => id));
    observer.recover(
      previous?.operations
        .filter(
          (operation) => !isEarnOperationTerminal(operation) && !observedIds.has(operation.id)
        )
        .map(({ id }) => id) ?? []
    );
    return {
      operations: mergeOperations(
        // Retain disappearing rows until the shared observer resolves their outcome.
        expanded
          ? (previous?.operations ?? [])
          : (previous?.operations.filter((operation) => !isEarnOperationTerminal(operation)) ?? []),
        recent?.operations ?? [],
        active
      ),
      activeIds: active.map(({ id }) => id),
      nextCursor: expanded ? (previous?.nextCursor ?? null) : (recent?.nextCursor ?? null),
      expanded,
    };
  }
  const { data, error, isLoading, isValidating, mutate } = useSWR(key, () => readFeed(), {
    refreshInterval: 15_000,
    revalidateOnFocus: true,
  });
  async function loadMore(): Promise<void> {
    const cursor = currentFeed()?.nextCursor;
    if (cursor === null || cursor === undefined || isLoadingMore) return;
    setIsLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      // Freeze the cursor before the request; an older poll must not replace this snapshot.
      await mutate((current) => (current ? { ...current, expanded: true } : current), {
        revalidate: false,
      });
      const page = await earnCoreClient.operations({
        cursor,
        limit: OPERATIONS_HISTORY_PAGE_SIZE,
      });
      if (page.nextCursor === cursor) throw new Error("Earn operation pagination did not advance");
      await mutate(
        (current) =>
          current
            ? {
                ...current,
                operations: mergeOperations(current.operations, page.operations),
                nextCursor: page.nextCursor,
                expanded: true,
              }
            : current,
        { revalidate: false }
      );
    } catch (caught) {
      setLoadMoreError(
        caught instanceof Error ? caught : new Error("Operation history unavailable")
      );
    } finally {
      setIsLoadingMore(false);
    }
  }
  return {
    operations: data?.operations,
    activeIds: data?.activeIds,
    error: error ?? loadMoreError ?? progress?.error,
    isLoading,
    isRefreshing: isValidating,
    hasMore: data?.nextCursor !== null && data?.nextCursor !== undefined,
    isLoadingMore,
    loadMore,
    refresh: async () => {
      setLoadMoreError(undefined);
      await mutate((current) => (current ? { ...current, expanded: false } : current), {
        revalidate: false,
      });
      return mutate();
    },
  };
}

/**
 * Activity rows observe the feed and shared cache without starting individual timers.
 * An open dialog registers recent accepted work with the one bounded observer.
 */
export function useEarnOperation(
  operationId: string | undefined,
  initial?: Operation,
  onUpdated?: (operation: Operation) => void,
  foreground?: boolean
) {
  const reported = useRef({
    id: operationId,
    observation: initial ? JSON.stringify(initial) : null,
  });
  const config = useSWRConfig();
  const observer = operationObserver(config);
  useEffect(() => {
    if (!foreground) return;
    const release = observer.retain();
    if (operationId) observer.focus(operationId);
    return release;
  }, [observer, foreground, operationId]);
  const { data: progress } = useSWR<ProgressObservation>(earnQueryKeys.operationProgress(), null);
  const { data, error, mutate } = useSWR(
    operationId ? earnQueryKeys.operation(operationId) : null,
    () => earnCoreClient.operation(operationId ?? ""),
    {
      fallbackData: initial,
      revalidateOnMount: initial === undefined,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      refreshInterval: 0,
    }
  );
  const operation = currentObservation(operationId, initial, data);
  useEffect(() => {
    if (operation) observer.observe(operation, foreground === true);
  }, [observer, operation, foreground]);
  const notifyUpdated = useEffectEvent((observed: Operation) => onUpdated?.(observed));
  useEffect(() => {
    if (reported.current.id !== operationId) {
      reported.current = { id: operationId, observation: initial ? JSON.stringify(initial) : null };
    }
    if (!operation) return;
    const observation = JSON.stringify(operation);
    if (reported.current.observation === observation) return;
    reported.current.observation = observation;
    // A shared request can finish after its initiating dialog unmounts. Notify
    // the remaining external activity/balance caches after commit; this does
    // not copy child render state into its parent (covered by the unmount test).
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
    // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent
    notifyUpdated(operation);
  }, [initial, operation, operationId]);
  return {
    operation,
    error: error ?? progress?.error,
    refresh: () => mutate(),
    update: (operation: Operation) => {
      observer.observe(operation, true);
      return mutate(operation, { revalidate: false });
    },
  };
}
