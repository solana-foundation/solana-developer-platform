"use client";

import type { PaymentTransferSummary } from "@sdp/types/payments";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { transferResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/payments-read-schemas";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";

/**
 * One transfer as the API holds it now, polled at the interval its latest state asks for. The
 * interval is passed through as a fresh function each render (see AGENTS.md on polling).
 */
export function useTransferRecord(
  transferId: string | null,
  pollInterval: (transfer: PaymentTransferSummary | undefined) => number
) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    transferId === null ? null : paymentsQueryKeys.transfer(scope, transferId),
    transferResponseSchema,
    {
      refreshInterval: (body) => pollInterval(body?.data.transfer),
      // The interval keeps it current; a focus read on top only doubles the calls.
      revalidateOnFocus: false,
    }
  );
  return { ...response, data: response.data?.data.transfer };
}
