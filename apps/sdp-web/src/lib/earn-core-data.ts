"use client";

import {
  isSdpProgressOperationStatus,
  isTerminalOperationStatus,
  type Operation,
} from "@sdp/types/operations";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { dashboardRequest } from "./dashboard-fetch";
import { createEarnClient } from "./earn-client";
import { useCadencedSWR } from "./use-cadenced-swr";

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

/** Recover every active operation while keeping automatic history reads bounded. */
export function useEarnOperations() {
  const { cache } = useSWRConfig();
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
    return {
      operations: mergeOperations(
        // Keep a disappearing row mounted until its existing detail poll reports the outcome.
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
    error: error ?? loadMoreError,
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

/** How often the operation open in the viewer's dialog is read while SDP is moving it. */
const OPERATION_WATCH_POLL_MS = 2_000;

/**
 * How often every other pending operation is read: activity rows, and provider settlements that
 * can take days. The shared feed already refreshes active rows every 15 s, so this is the safety
 * net for a row that leaves it, and it keeps many pending rows under the dashboard's shared
 * request limit.
 */
const OPERATION_BACKGROUND_POLL_MS = 30_000;

/**
 * SWR's poll revalidates with dedupe, so under the dashboard's 10 s default a 2 s poll lands
 * every 10 s. The window must also stay under the cadence: SWR clears it only after a read
 * lands, so a window equal to the cadence still swallows every other tick. Half still joins the
 * dialog and its activity row when both watch one operation.
 */
const OPERATION_POLL_DEDUPE_MS = OPERATION_WATCH_POLL_MS / 2;

/**
 * The detail read cadence for one operation.
 *
 * @param operation - The latest observation, if any.
 * @param foreground - Whether the viewer has this operation open in a dialog.
 * @returns The poll interval in milliseconds, 0 once the operation is terminal.
 */
function operationPollInterval(operation: Operation | undefined, foreground: boolean): number {
  if (operation && isEarnOperationTerminal(operation)) return 0;
  return foreground && operation && isSdpProgressOperationStatus(operation.status)
    ? OPERATION_WATCH_POLL_MS
    : OPERATION_BACKGROUND_POLL_MS;
}

/**
 * Detail polling is scoped to the operation; closing a modal never owns progress.
 *
 * @param operationId - The operation to read.
 * @param initial - The observation the caller already holds.
 * @param onUpdated - Told about each new observation after commit.
 * @param foreground - True for the operation open in the viewer's dialog, read every 2 s while
 *   SDP is moving it. Activity rows leave it out and are read every 30 s beside the feed.
 * @returns The current observation, its read error, and refresh and update handles.
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
  const { data, error, mutate } = useCadencedSWR(
    operationId ? earnQueryKeys.operation(operationId) : null,
    () => earnCoreClient.operation(operationId ?? ""),
    (latest) =>
      operationPollInterval(currentObservation(operationId, initial, latest), foreground === true),
    {
      fallbackData: initial,
      dedupingInterval: OPERATION_POLL_DEDUPE_MS,
    }
  );
  const operation = currentObservation(operationId, initial, data);
  const notifyUpdated = useEffectEvent((observed: Operation) => onUpdated?.(observed));
  useEffect(() => {
    if (reported.current.id !== operationId) {
      reported.current = { id: operationId, observation: initial ? JSON.stringify(initial) : null };
    }
    if (!operation) return;
    const observation = JSON.stringify(operation);
    if (reported.current.observation === observation) return;
    reported.current.observation = observation;
    if (operation === initial) return;
    // A shared request can finish after its initiating dialog unmounts. Notify
    // the remaining external activity/balance caches after commit; this does
    // not copy child render state into its parent (covered by the unmount test).
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
    // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent
    notifyUpdated(operation);
  }, [initial, operation, operationId]);
  return {
    operation,
    error,
    refresh: () => mutate(),
    update: (operation: Operation) => mutate(operation, { revalidate: false }),
  };
}
