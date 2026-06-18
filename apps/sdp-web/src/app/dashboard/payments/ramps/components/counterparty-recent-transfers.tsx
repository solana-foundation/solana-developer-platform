"use client";

import { SUCCESSFUL_PAYMENT_TRANSFER_STATUSES } from "@sdp/types";
import { ArrowRightIcon } from "lucide-react";
import Image from "next/image";
import useSWR from "swr";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { formatRelativeTime } from "../../../activity-format-utils";
import { resolveTransferFlow, resolveTransferTypeLabel } from "../../payments-overview.utils";
import { fetchTransfers } from "../../payments-workspace.data";

const RECENT_TRANSFERS_MAX_ROWS = 5;

const SKELETON_ROWS = [
  { key: "row-1", provider: "w-24", type: "w-16", amount: "w-36", time: "w-16" },
  { key: "row-2", provider: "w-20", type: "w-14", amount: "w-40", time: "w-12" },
  { key: "row-3", provider: "w-24", type: "w-16", amount: "w-32", time: "w-20" },
] as const;

export function CounterpartyRecentTransfers({ counterpartyId }: { counterpartyId: string }) {
  const { data, error } = useSWR(
    ["counterparty-recent-transfers", counterpartyId],
    () =>
      fetchTransfers({
        pageSize: RECENT_TRANSFERS_MAX_ROWS,
        counterpartyId,
        statuses: SUCCESSFUL_PAYMENT_TRANSFER_STATUSES,
      }),
    { revalidateOnFocus: false, revalidateIfStale: false, keepPreviousData: false }
  );

  if (error) {
    return (
      <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
        {error instanceof Error ? error.message : "Recent transfers request failed."}
      </div>
    );
  }

  if (!data) {
    return (
      <section className="space-y-3">
        <SkeletonBlock className="h-8 w-48" />
        <div>
          {SKELETON_ROWS.map((row) => (
            <div key={row.key} className="flex items-center gap-3 py-3">
              <SkeletonBlock className="size-6" />
              <SkeletonBlock className={`h-4 ${row.provider}`} />
              <div className="min-w-0 flex-1">
                <SkeletonBlock className={`h-4 ${row.type}`} />
              </div>
              <SkeletonBlock className={`h-4 ${row.amount}`} />
              <SkeletonBlock className={`h-3 ${row.time}`} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (data.length === 0) {
    return (
      <section className="space-y-3">
        <h2 className="text-2xl font-medium text-text-extra-high">Recent Transfers</h2>
        <p className="py-3 text-sm text-text-low">No recent transactions.</p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="text-2xl font-medium text-text-extra-high">Recent Transfers</h2>
      <div>
        {data.map((transfer) => {
          const flow = resolveTransferFlow(transfer);

          return (
            <div key={transfer.id} className="flex items-center gap-3 py-3">
              {transfer.provider ? (
                <>
                  <Image
                    src={RAMP_PROVIDER_LOGOS[transfer.provider]}
                    alt=""
                    width={24}
                    height={24}
                    className="size-6 rounded-md object-contain"
                  />
                  <span className="text-sm font-medium text-text-extra-high">
                    {getRampProviderLabel(transfer.provider)}
                  </span>
                </>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm text-text-medium">
                {resolveTransferTypeLabel(transfer.type)}
              </span>
              {flow.send || flow.receive ? (
                <span className="flex shrink-0 items-center gap-1.5 text-sm">
                  {flow.send ? <span className="text-text-medium">{flow.send}</span> : null}
                  {flow.send && flow.receive ? (
                    <ArrowRightIcon className="size-3.5 text-text-low" />
                  ) : null}
                  {flow.receive ? (
                    <span className="font-medium text-text-extra-high">{flow.receive}</span>
                  ) : null}
                </span>
              ) : null}
              {transfer.createdAt ? (
                <span className="shrink-0 text-xs text-text-low">
                  {formatRelativeTime(transfer.createdAt)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
