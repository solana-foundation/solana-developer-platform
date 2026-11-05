"use client";

import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import {
  DashboardReadError,
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardSWR,
} from "@/lib/dashboard-swr";
import { counterpartyResponseSchema } from "./counterparty-read-schemas";

/**
 * One counterparty read that tells a missing record from a failed read: the API answers 404 for
 * an archived counterparty as for one that never existed, so a record something still points at
 * (a recurring payment's recipient) is `missing` because it was archived (HOO-2634).
 */
export type CounterpartyLookup =
  | { kind: "found"; counterparty: { displayName: string } }
  | { kind: "missing" }
  | { kind: "failed" };

async function readCounterpartyLookups(
  key: DashboardRequestKey
): Promise<{ id: string; lookup: CounterpartyLookup }[]> {
  const scope = { projectId: key[0], mode: key[1] };
  const ids = String(key[3]?.ids ?? "")
    .split(",")
    .filter((id) => id !== "");
  return Promise.all(
    ids.map(async (id) => {
      try {
        const body = await readDashboardRequest(
          paymentsQueryKeys.counterparty(scope, id),
          counterpartyResponseSchema
        );
        return { id, lookup: { kind: "found", counterparty: body.data.counterparty } as const };
      } catch (error) {
        if (error instanceof DashboardReadError && error.status === 404) {
          return { id, lookup: { kind: "missing" } as const };
        }
        // One failed name only costs that label; the caller says some could not be read.
        return { id, lookup: { kind: "failed" } as const };
      }
    })
  );
}

/** The contacts a page of rows names, read together under one entry. */
export function useCounterpartyLookups(counterpartyIds: readonly string[] | undefined) {
  const scope = useDashboardKeyScope();
  return useDashboardSWR(
    counterpartyIds === undefined || counterpartyIds.length === 0
      ? null
      : paymentsQueryKeys.counterpartyLookups(scope, counterpartyIds),
    readCounterpartyLookups,
    // A new page of rows keeps the names already read while its own load.
    { keepPreviousData: true }
  );
}
