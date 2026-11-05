"use client";

import type { Counterparty } from "@sdp/types/counterparties";
import type { CounterpartyAccountSummary } from "@sdp/types/payments";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { projectCounterpartyAccountsResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/payments-read-schemas";
import { type DashboardRequestKey, dashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest, useDashboardKeyScope, useDashboardSWR } from "@/lib/dashboard-swr";
import { counterpartiesPageResponseSchema } from "./counterparty-read-schemas";

function pageKey(key: DashboardRequestKey, page: number): DashboardRequestKey {
  const { cap: _cap, ...params } = key[3] ?? {};
  return dashboardRequestKey({ projectId: key[0], mode: key[1] }, key[2], { ...params, page });
}

function capOf(key: DashboardRequestKey): number {
  return Number(key[3]?.cap);
}

/**
 * Every counterparty up to the key's `cap`, read in pages. The list API has no search or type
 * filter, so the Contact list loads the directory once and searches it locally.
 */
async function readCounterpartyDirectory(
  key: DashboardRequestKey
): Promise<{ counterparties: Counterparty[]; total: number }> {
  const pageSize = Number(key[3]?.pageSize);
  const first = await readDashboardRequest(pageKey(key, 1), counterpartiesPageResponseSchema);
  const pages = Math.ceil(Math.min(first.data.total, capOf(key)) / pageSize);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      readDashboardRequest(pageKey(key, index + 2), counterpartiesPageResponseSchema)
    )
  );
  // The pages are offsets into a list ordered by creation time alone, so a contact created in
  // the same instant as its neighbour can land on two pages; keep the first copy.
  const seen = new Set<string>();
  const counterparties = [first, ...rest]
    .flatMap((body) => body.data.counterparties)
    .filter((counterparty) => {
      if (seen.has(counterparty.id)) return false;
      seen.add(counterparty.id);
      return true;
    });
  return { counterparties: counterparties.slice(0, capOf(key)), total: first.data.total };
}

/** The Project's saved Solana addresses across every counterparty, up to the key's `cap`. */
async function readCounterpartyAddressDirectory(
  key: DashboardRequestKey
): Promise<{ accounts: CounterpartyAccountSummary[]; total: number }> {
  const pageSize = Number(key[3]?.pageSize);
  const accounts: CounterpartyAccountSummary[] = [];
  let total = 0;
  for (let page = 1; accounts.length < capOf(key); page += 1) {
    const body = await readDashboardRequest(
      pageKey(key, page),
      projectCounterpartyAccountsResponseSchema
    );
    total = body.data.total;
    accounts.push(...body.data.accounts);
    if (body.data.accounts.length < pageSize || accounts.length >= total) break;
  }
  return { accounts: accounts.slice(0, capOf(key)), total: Math.max(total, accounts.length) };
}

export function useCounterpartyDirectory() {
  const scope = useDashboardKeyScope();
  return useDashboardSWR(paymentsQueryKeys.counterpartyDirectory(scope), readCounterpartyDirectory);
}

export function useCounterpartyAddressDirectory() {
  const scope = useDashboardKeyScope();
  return useDashboardSWR(
    paymentsQueryKeys.counterpartyAddressDirectory(scope),
    readCounterpartyAddressDirectory
  );
}
