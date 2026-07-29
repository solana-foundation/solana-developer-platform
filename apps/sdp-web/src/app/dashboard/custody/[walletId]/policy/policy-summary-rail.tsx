"use client";

import {
  type PaymentWalletPolicy,
  type PolicyProfileStatus,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { ChevronRight, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import type { PolicyAssetOption, PolicyAuthoringState } from "./wallet-policy-authoring";
import {
  CATEGORY_OPTIONS,
  DEFAULT_ACTION_LABEL_KEYS,
  operationControlCount,
  type PolicyFlowWallet,
} from "./wallet-policy-flow.shared";

export function PolicySummaryRail({
  wallet,
  policy,
  state,
  stepIndex,
  destinationCount,
  assetOptions,
}: {
  wallet: PolicyFlowWallet;
  policy: PaymentWalletPolicy;
  state: PolicyAuthoringState;
  stepIndex: number;
  destinationCount: number;
  assetOptions: PolicyAssetOption[];
}) {
  const t = useTranslations();
  const status = policy.controlProfile?.status ?? null;
  const assetByMint = new Map(assetOptions.map((option) => [option.mint, option]));
  const selectedCategories = CATEGORY_OPTIONS.filter((category) =>
    state.categories.includes(category.id)
  );
  const rows: Array<{
    label: string;
    value: ReactNode;
    collapsedCount?: number;
  }> = [
    { label: t("DashboardCustody.policySummaryStatus"), value: formatProfileStatus(status, t) },
    {
      label: t("DashboardCustody.policyRevision"),
      value: policy.controlProfile?.revisionNumber
        ? `#${policy.controlProfile.revisionNumber}`
        : t("DashboardCustody.policyStatusNotActivated"),
    },
    {
      label: t("DashboardCustody.policySummaryDefaultAction"),
      value: t(DEFAULT_ACTION_LABEL_KEYS[state.defaultAction]),
    },
    selectedCategories.length
      ? {
          label: t("DashboardCustody.policySummaryControlAreas"),
          collapsedCount: selectedCategories.length,
          value: selectedCategories.map((category) => (
            <span key={category.id} className="block text-sm font-medium text-primary">
              {t(category.titleKey)}
            </span>
          )),
        }
      : {
          label: t("DashboardCustody.policySummaryControlAreas"),
          value: t("DashboardCustody.policyNotConfigured"),
        },
  ];

  if (stepIndex >= 1 && state.categories.includes("limits")) {
    const maxTransferAmount = state.maxTransferAmount.trim();
    const maxDailyAmount = state.maxDailyAmount.trim();
    if (!maxTransferAmount && !maxDailyAmount) {
      rows.push({
        label: t("DashboardCustody.policyReviewTransferLimits"),
        value: t("DashboardCustody.policyNotConfigured"),
      });
    }
    if (maxTransferAmount) {
      rows.push({ label: t("DashboardCustody.policyPerTransaction"), value: maxTransferAmount });
    }
    if (maxDailyAmount) {
      rows.push({ label: t("DashboardCustody.policyDailyTotal"), value: maxDailyAmount });
    }
  }
  if (stepIndex >= 1 && state.categories.includes("assets")) {
    if (state.assets.length) {
      rows.push({
        label: t("DashboardCustody.policySummaryAllowedAssets"),
        collapsedCount: state.assets.length,
        value: state.assets.map((mint) => {
          const option = assetByMint.get(mint);
          return (
            <span key={mint} className="flex items-center gap-2" title={mint}>
              <TokenMark mint={mint} symbol={option?.token} size="sm" />
              <span className="min-w-0 truncate text-sm font-medium text-primary">
                {option?.token ?? t("DashboardCustody.policyCustomMint")}
              </span>
              {WELL_KNOWN_TOKEN_BY_MINT.has(mint) ? null : (
                <Badge className="shrink-0">
                  {option?.source === "issued"
                    ? t("DashboardCustody.policyAssetBadgeIssued")
                    : t("DashboardCustody.policyAssetBadgeCustom")}
                </Badge>
              )}
              <span className="ml-auto shrink-0 text-xs text-muted">{shortenAddress(mint)}</span>
            </span>
          );
        }),
      });
    } else {
      rows.push({
        label: t("DashboardCustody.policySummaryAllowedAssets"),
        value: t("DashboardCustody.policyNotConfigured"),
      });
    }
  }
  if (stepIndex >= 2 && state.categories.includes("destinations")) {
    rows.push({
      label: t("DashboardCustody.policySummaryDestinations"),
      value: String(destinationCount),
    });
  }
  if (stepIndex >= 2 && state.categories.includes("operations")) {
    rows.push({
      label: t("DashboardCustody.policyReviewOperationControls"),
      value: String(operationControlCount(state)),
    });
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(wallet.publicKey);
      toast.success(t("DashboardCustody.policyAddressCopied"), { position: "bottom-right" });
    } catch {
      // Clipboard availability depends on browser permissions; the full address remains in the tooltip.
    }
  }

  return (
    <aside className="h-fit rounded-lg border border-border-default bg-surface-raised p-6 lg:sticky lg:top-0">
      <h2 className="text-base font-semibold text-primary">
        {t("DashboardCustody.policySummary")}
      </h2>
      <dl className="mt-4 divide-y divide-border-default">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{t("DashboardCustody.policySummaryWallet")}</dt>
          <dd className="max-w-48 truncate text-right text-sm font-medium text-primary">
            {wallet.label || wallet.walletId}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-sm text-muted">{t("DashboardCustody.policySummaryAddress")}</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={copyAddress}
                    className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-primary"
                    aria-label={t("DashboardCustody.policyCopyAddress")}
                  >
                    <span className="max-w-40 truncate">{wallet.publicKey}</span>
                    <Copy className="size-3.5 shrink-0 text-muted" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{wallet.publicKey}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </dd>
        </div>
        {rows.map((row) =>
          row.collapsedCount !== undefined ? (
            <div key={row.label} className="py-3">
              <details className="group/summary-row">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
                  <span className="text-sm text-muted">{row.label}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-primary">
                    {t("DashboardCustody.policySummarySelectedCount", {
                      count: row.collapsedCount,
                    })}
                    <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open/summary-row:rotate-90" />
                  </span>
                </summary>
                <div className="mt-2.5 space-y-2">{row.value}</div>
              </details>
            </div>
          ) : (
            <div key={row.label} className="flex items-center justify-between gap-4 py-3">
              <dt className="shrink-0 text-sm text-muted">{row.label}</dt>
              <dd className="min-w-0 text-right text-sm font-medium text-primary">{row.value}</dd>
            </div>
          )
        )}
      </dl>
    </aside>
  );
}

function formatProfileStatus(
  status: PolicyProfileStatus | null,
  t: ReturnType<typeof useTranslations>
): string {
  if (!status) return t("DashboardCustody.policyStatusDefaultAllow");
  const labels = {
    active: "DashboardCustody.policyStatusActive",
    draft: "DashboardCustody.policyStatusDraft",
    disabled: "DashboardCustody.policyStatusDisabled",
    archived: "DashboardCustody.policyStatusArchived",
  } as const;
  return t(labels[status]);
}
