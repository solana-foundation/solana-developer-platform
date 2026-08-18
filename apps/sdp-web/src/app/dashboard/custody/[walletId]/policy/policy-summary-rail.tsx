"use client";

import type { PaymentWalletPolicy, PolicyProfileStatus } from "@sdp/types";
import { ChevronRight, Copy } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { TokenMark } from "@/components/token-mark";
import { HeightReveal } from "@/components/ui/height-reveal";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { PolicyAssetBadge } from "./policy-asset-badge";
import {
  type PolicyAssetOption,
  type PolicyAuthoringState,
  parseDestinationText,
  WALLET_OPERATION_FAMILIES,
} from "./wallet-policy-authoring";
import {
  CATEGORY_OPTIONS,
  DEFAULT_ACTION_LABEL_KEYS,
  FAMILY_LABEL_KEYS,
  type PolicyFlowWallet,
  RULE_ACTION_LABEL_KEYS,
} from "./wallet-policy-flow.shared";

export function PolicySummaryRail({
  wallet,
  policy,
  state,
  stepIndex,
  assetOptions,
}: {
  wallet: PolicyFlowWallet;
  policy: PaymentWalletPolicy;
  state: PolicyAuthoringState;
  stepIndex: number;
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
    const configuredLimits = state.limits.filter((limit) => limit.max.trim() !== "");
    if (configuredLimits.length === 0) {
      rows.push({
        label: t("DashboardCustody.policyReviewTransferLimits"),
        value: t("DashboardCustody.policyNotConfigured"),
      });
    } else {
      const limitValues = configuredLimits.map((limit) => {
        const option = assetByMint.get(limit.asset);
        const assetLabel = option ? option.token : shortenAddress(limit.asset);
        return (
          <span key={limit.asset} className="flex items-center gap-2" title={limit.asset}>
            <TokenMark
              mint={limit.asset}
              symbol={option ? option.token : undefined}
              logoUrl={option ? option.imageUrl : undefined}
              size="sm"
            />
            <span className="min-w-0 truncate text-sm font-medium text-primary">
              {limit.max.trim()} {assetLabel}
            </span>
            <PolicyAssetBadge mint={limit.asset} option={option} />
          </span>
        );
      });
      rows.push({
        label: t("DashboardCustody.policyPerTransaction"),
        collapsedCount: configuredLimits.length,
        value: limitValues,
      });
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
              <TokenMark mint={mint} symbol={option?.token} logoUrl={option?.imageUrl} size="sm" />
              <span className="min-w-0 truncate text-sm font-medium text-primary">
                {option?.token ?? t("DashboardCustody.policyCustomMint")}
              </span>
              <PolicyAssetBadge mint={mint} option={option} />
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
    const destinationEntries = [
      ...parseDestinationText(state.destinationAllowText).valid.map((address) => ({
        address,
        action: "allow" as const,
      })),
      ...parseDestinationText(state.destinationBlockText).valid.map((address) => ({
        address,
        action: "deny" as const,
      })),
    ];
    if (destinationEntries.length === 0) {
      rows.push({
        label: t("DashboardCustody.policySummaryDestinations"),
        value: t("DashboardCustody.policyNotConfigured"),
      });
    } else {
      rows.push({
        label: t("DashboardCustody.policySummaryDestinations"),
        collapsedCount: destinationEntries.length,
        value: destinationEntries.map((entry) => (
          <span
            key={`${entry.action}:${entry.address}`}
            className="block text-sm font-medium text-primary"
            title={entry.address}
          >
            {shortenAddress(entry.address)} · {t(RULE_ACTION_LABEL_KEYS[entry.action])}
          </span>
        )),
      });
    }
  }
  if (stepIndex >= 2 && state.categories.includes("operations")) {
    const operationControls = [
      ...WALLET_OPERATION_FAMILIES.flatMap((family) => {
        const action = state.familyActions[family];
        return action ? [{ key: family, label: t(FAMILY_LABEL_KEYS[family]), action }] : [];
      }),
      ...state.operationTypeRules.map((rule) => ({
        key: rule.value,
        label: rule.value,
        action: rule.action,
      })),
    ];
    if (operationControls.length === 0) {
      rows.push({
        label: t("DashboardCustody.policyReviewOperationControls"),
        value: t("DashboardCustody.policyNotConfigured"),
      });
    } else {
      rows.push({
        label: t("DashboardCustody.policyReviewOperationControls"),
        collapsedCount: operationControls.length,
        value: operationControls.map((control) => (
          <span key={control.key} className="block text-sm font-medium text-primary">
            {control.label} · {t(RULE_ACTION_LABEL_KEYS[control.action])}
          </span>
        )),
      });
    }
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
            <CollapsibleSummaryRow key={row.label} label={row.label} count={row.collapsedCount}>
              {row.value}
            </CollapsibleSummaryRow>
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

/**
 * Summary-rail row whose value list expands beneath the count with the shared
 * height-reveal animation.
 *
 * @param props.label - Row label shown on the left.
 * @param props.count - Number of selected entries shown as the collapsed value.
 * @param props.children - The expanded entry list.
 * @returns The toggleable row.
 */
function CollapsibleSummaryRow({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <div className="py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full cursor-pointer items-center justify-between gap-4"
      >
        <span className="text-sm text-muted">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-sm font-medium text-primary">
          {t("DashboardCustody.policySummarySelectedCount", { count })}
          <ChevronRight
            className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      <AnimatePresence>
        {open ? (
          <HeightReveal key="summary-row">
            <div className="space-y-2 pt-2.5">{children}</div>
          </HeightReveal>
        ) : null}
      </AnimatePresence>
    </div>
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
