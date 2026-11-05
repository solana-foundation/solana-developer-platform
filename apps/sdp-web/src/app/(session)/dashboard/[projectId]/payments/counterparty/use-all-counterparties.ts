"use client";

import type { Counterparty } from "@sdp/types/counterparties";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import type { CounterpartiesResult } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { type DashboardRequestKey, dashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest, useDashboardKeyScope, useDashboardSWR } from "@/lib/dashboard-swr";
import { counterpartiesPageResponseSchema } from "./counterparty-read-schemas";

const MAX_COUNTERPARTY_PAGES = 50;

/** Every contact, one request per page, under a single cache entry. */
async function readAllCounterparties(key: DashboardRequestKey): Promise<Counterparty[]> {
  const counterparties: Counterparty[] = [];
  for (let page = 1; page <= MAX_COUNTERPARTY_PAGES; page += 1) {
    const body = await readDashboardRequest(
      dashboardRequestKey({ projectId: key[0], mode: key[1] }, key[2], { ...key[3], page }),
      counterpartiesPageResponseSchema
    );
    counterparties.push(...body.data.counterparties);
    if (counterparties.length >= body.data.total || body.data.counterparties.length === 0) {
      break;
    }
  }
  return counterparties;
}

/** The contact pickers' read: every contact, with its own loading and failed states. */
export interface CounterpartyOptions {
  result: CounterpartiesResult;
  loading: boolean;
  retry: () => void;
  /** Puts a contact just created at the top of the list, then reads the list again. */
  addCreated: (created: Counterparty) => void;
}

/** Every contact in the Project. */
export function useAllCounterparties(): CounterpartyOptions {
  const t = useTranslations();
  const scope = useDashboardKeyScope();
  const { data, error, mutate } = useDashboardSWR(
    paymentsQueryKeys.allCounterparties(scope),
    readAllCounterparties
  );
  const result: CounterpartiesResult =
    error !== undefined
      ? { ok: false, data: [], error: t("DashboardPayments.ramps.counterpartiesLoadFailed") }
      : { ok: true, data: data ?? [] };
  return {
    result,
    loading: data === undefined && error === undefined,
    retry: () => void mutate(),
    addCreated: (created) =>
      void mutate((previous) => [created, ...(previous ?? [])], { revalidate: true }),
  };
}
