"use client";

import type { Operation } from "@sdp/types/operations";
import { useRef } from "react";
import useSWR from "swr";
import { dashboardRequest } from "./dashboard-fetch";
import { createEarnClient, type EarnOperationsQuery } from "./earn-client";

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
  return (
    operation.status === "completed" ||
    operation.status === "failed" ||
    operation.status === "cancelled"
  );
}

/** A bounded recovery feed must fail on cursor cycles instead of silently hiding operations. */
export async function fetchEarnOperations(query: EarnOperationsQuery = {}): Promise<Operation[]> {
  const operations: Operation[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await earnCoreClient.operations({ ...query, limit: 100, cursor: before });
    operations.push(...result.operations);
    if (result.nextCursor === null) return operations;
    if (seen.has(result.nextCursor)) throw new Error("Earn operation pagination did not advance");
    seen.add(result.nextCursor);
    before = result.nextCursor;
  }
  throw new Error("Earn operation pagination exceeded its safety limit");
}

/** Recover durable work on reload, including provider signing and settlement waits. */
export function useEarnOperations() {
  const { data, error, isLoading, mutate } = useSWR(
    "dashboard-earn-core-operations",
    () => fetchEarnOperations(),
    { refreshInterval: 15_000, revalidateOnFocus: true }
  );
  return { operations: data, error, isLoading, refresh: () => void mutate() };
}

/** Fast detail polling is scoped to the operation; closing a modal never owns progress. */
export function useEarnOperation(
  operationId: string | undefined,
  initial?: Operation,
  onUpdated?: (operation: Operation) => void
) {
  const reported = useRef<string | null>(null);
  const { data, error, mutate } = useSWR(
    operationId ? ["dashboard-earn-operation", operationId] : null,
    () => earnCoreClient.operation(operationId ?? ""),
    {
      fallbackData: initial,
      refreshInterval: (latest) => {
        const operation = latest ?? initial;
        return operation && isEarnOperationTerminal(operation) ? 0 : 2_000;
      },
      onSuccess(operation) {
        const observation = JSON.stringify([
          operation.id,
          operation.status,
          operation.version,
          operation.updatedAt,
        ]);
        if (reported.current === observation) return;
        reported.current = observation;
        onUpdated?.(operation);
      },
    }
  );
  return {
    operation: data,
    error,
    refresh: () => mutate(),
    update: (operation: Operation) => mutate(operation, { revalidate: false }),
  };
}
