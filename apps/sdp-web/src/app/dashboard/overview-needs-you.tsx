"use client";

import type { WalletApprovalRequestSummary } from "@sdp/types";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import { DASHBOARD_SIDE_NAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatRelativeTime } from "./activity-format-utils";
import {
  approvalReason,
  approvalWalletLabel,
  formatApprovalLabel,
} from "./approvals/approval-requests.data";
import { shortenAddress } from "./payments/payments-overview.utils";

const NEEDS_YOU_KEY = "dashboard-overview-needs-you";

/** "2.00 SOL", "15,000.00 USDC": always two decimals, as the rest of the list reads money. */
function formatApprovalAmount(
  amount: string | null,
  asset: string | null,
  locale: string
): string | null {
  if (!amount) return null;
  const value = Number(amount);
  const figure = Number.isFinite(value)
    ? new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(
        value
      )
    : amount;
  // An asset without a symbol arrives as its mint.
  return asset ? `${figure} ${asset.length > 12 ? shortenAddress(asset) : asset}` : figure;
}
const NEEDS_YOU_ROWS = 4;

/**
 * Pending approvals this viewer can decide, oldest first: the longest wait leads. The same
 * read the sidebar badge makes, narrowed to requests the viewer may approve or reject.
 */
async function fetchApprovalsNeedingViewer(): Promise<WalletApprovalRequestSummary[]> {
  const response = await fetch("/api/dashboard/approval-requests?status=pending&limit=100", {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Approval requests failed (${response.status})`);
  const body = (await response.json()) as {
    data?: { approvalRequests?: WalletApprovalRequestSummary[] };
  };
  return (body.data?.approvalRequests ?? [])
    .filter((request) => request.viewerCanDecide)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * "Needs you": approvals waiting on this viewer, a line each with what it moves and why a policy
 * stopped it. Renders nothing while loading, on a failed read, and when nothing is waiting, so
 * the Overview only gains the section when there is something to do.
 */
export function OverviewNeedsYou() {
  const t = useTranslations();
  const locale = useLocale();
  const { data } = usePersistedDashboardSWR(
    NEEDS_YOU_KEY,
    fetchApprovalsNeedingViewer,
    { revalidateOnFocus: true, refreshInterval: 60_000 },
    { key: "overview-needs-you", ttlMs: 60_000 }
  );
  if (!data || data.length === 0) return null;
  const rows = data.slice(0, NEEDS_YOU_ROWS);

  return (
    <section
      aria-labelledby="overview-needs-you-title"
      data-overview-section="needs-you"
      className="min-w-0"
    >
      <div className="flex items-center justify-between gap-4">
        <h2
          id="overview-needs-you-title"
          className="flex items-center gap-3 text-subheading font-medium text-primary"
        >
          {t("Shared.homeWorkspace.needsYou.title")}
          <span
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 items-center justify-center rounded-control-inner bg-fill px-1.5 text-body font-normal text-secondary tabular-nums"
          >
            {data.length}
          </span>
          <span className="sr-only">
            {t("Shared.homeWorkspace.needsYou.count", { count: data.length })}
          </span>
        </h2>
        <Button asChild variant="outline" size="sm">
          <Link href={DASHBOARD_SIDE_NAV_HREFS.approvals}>
            {t("Shared.homeWorkspace.needsYou.all")}
          </Link>
        </Button>
      </div>
      <ul className="mt-2.5 divide-y divide-border-subtle">
        {rows.map((request) => {
          const { operation } = request;
          const amount = formatApprovalAmount(operation.amount, operation.asset, locale);
          return (
            <li key={request.id}>
              {/* 44px of text in a 10px inset: a 16px line over a 14px line. */}
              <Link
                href={`${DASHBOARD_SIDE_NAV_HREFS.approvals}/${encodeURIComponent(request.id)}`}
                className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 rounded-control px-2 py-2.5 transition-colors hover:bg-fill-subtle focus-visible:outline-2 focus-visible:-outline-offset-2"
              >
                <span className="min-w-0">
                  <span className="block truncate text-field text-primary">
                    {t("Shared.homeWorkspace.needsYou.row", {
                      operation: formatApprovalLabel(operation.operationType),
                      wallet: approvalWalletLabel(request),
                    })}
                  </span>
                  <span className="block truncate text-body text-secondary">
                    {approvalReason(request, t("Shared.homeWorkspace.needsYou.approvalRequired"))}
                  </span>
                </span>
                <span className="flex flex-col items-end justify-end text-right">
                  {amount ? (
                    <span className="text-field text-primary tabular-nums">{amount}</span>
                  ) : null}
                  <span className="text-body text-tertiary">
                    {formatRelativeTime(request.createdAt, locale)}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
