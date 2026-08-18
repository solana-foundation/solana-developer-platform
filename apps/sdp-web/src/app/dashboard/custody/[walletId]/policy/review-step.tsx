"use client";

import type { ReactNode } from "react";
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { PolicyAssetBadge } from "./policy-asset-badge";
import {
  type PolicyAssetOption,
  type PolicyAuthoringState,
  type PolicyFlowStep,
  parseDestinationText,
  type RestrictionCategory,
  WALLET_OPERATION_FAMILIES,
} from "./wallet-policy-authoring";
import {
  DEFAULT_ACTION_LABEL_KEYS,
  FAMILY_LABEL_KEYS,
  RULE_ACTION_LABEL_KEYS,
} from "./wallet-policy-flow.shared";

export function ReviewStep({
  state,
  assetOptions,
  noRestrictions,
  onEdit,
}: {
  state: PolicyAuthoringState;
  assetOptions: PolicyAssetOption[];
  noRestrictions: boolean;
  onEdit: (step: PolicyFlowStep, category?: RestrictionCategory) => void;
}) {
  const t = useTranslations();
  const assetByMint = new Map(assetOptions.map((option) => [option.mint, option]));
  const allowDestinations = parseDestinationText(state.destinationAllowText).valid;
  const blockDestinations = parseDestinationText(state.destinationBlockText).valid;
  const familyEntries = WALLET_OPERATION_FAMILIES.flatMap((family) => {
    const action = state.familyActions[family];
    return action ? [{ family, action }] : [];
  });

  const configuredLimits = state.categories.includes("limits")
    ? state.limits.flatMap((limit) => {
        const amount = limit.max.trim();
        if (!amount) return [];
        const option = assetByMint.get(limit.asset);
        const asset = option ? option.token : shortenAddress(limit.asset);
        return [{ amount, asset, limit, option }];
      })
    : [];

  const reviewRows: Array<{
    label: string;
    value: ReactNode;
    step: PolicyFlowStep;
    category?: RestrictionCategory;
  }> = [
    {
      label: t("DashboardCustody.policyDefaultAction"),
      value: t(DEFAULT_ACTION_LABEL_KEYS[state.defaultAction]),
      step: "intent",
    },
    {
      label: t("DashboardCustody.policyReviewTransferLimits"),
      value: configuredLimits.length ? (
        <span className="block space-y-0.5">
          {configuredLimits.map(({ amount, asset, limit, option }) => (
            <span key={limit.asset} className="flex items-center gap-2" title={limit.asset}>
              <span>
                {t("DashboardCustody.policyReviewPerTransactionAsset", { amount, asset })}
              </span>
              <PolicyAssetBadge mint={limit.asset} option={option} />
            </span>
          ))}
        </span>
      ) : null,
      step: "limits-assets",
      category: "limits",
    },
    {
      label: t("DashboardCustody.policyReviewAllowedAssets"),
      value: state.assets.length ? (
        <span className="block space-y-0.5">
          {state.assets.map((mint) => {
            const option = assetByMint.get(mint);
            return (
              <span key={mint} className="flex items-center gap-2" title={mint}>
                <span>
                  {option ? option.token : t("DashboardCustody.policyCustomMint")}
                  <span className="text-muted"> · {shortenAddress(mint)}</span>
                </span>
                <PolicyAssetBadge mint={mint} option={option} />
              </span>
            );
          })}
        </span>
      ) : null,
      step: "limits-assets",
      category: "assets",
    },
    {
      label: t("DashboardCustody.policyReviewDestinationControls"),
      value:
        allowDestinations.length || blockDestinations.length ? (
          <span className="block space-y-2">
            {(
              [
                { labelKey: "DashboardCustody.policyAllowList", entries: allowDestinations },
                { labelKey: "DashboardCustody.policyBlockList", entries: blockDestinations },
              ] as const
            )
              .filter((group) => group.entries.length > 0)
              .map((group) => (
                <span key={group.labelKey} className="block">
                  <span className="block text-xs font-medium text-muted">{t(group.labelKey)}</span>
                  {group.entries.map((entry) => (
                    <span key={entry} className="block" title={entry}>
                      {shortenAddress(entry)}
                    </span>
                  ))}
                </span>
              ))}
          </span>
        ) : null,
      step: "destinations-operations",
      category: "destinations",
    },
    {
      label: t("DashboardCustody.policyReviewOperationControls"),
      value:
        familyEntries.length || state.operationTypeRules.length ? (
          <span className="block space-y-0.5">
            {familyEntries.map((entry) => (
              <span key={entry.family} className="block">
                {t(FAMILY_LABEL_KEYS[entry.family])}
                <span className="text-muted"> · {t(RULE_ACTION_LABEL_KEYS[entry.action])}</span>
              </span>
            ))}
            {state.operationTypeRules.map((rule) => (
              <span key={rule.value} className="block">
                {rule.value}
                <span className="text-muted"> · {t(RULE_ACTION_LABEL_KEYS[rule.action])}</span>
              </span>
            ))}
          </span>
        ) : null,
      step: "destinations-operations",
      category: "operations",
    },
  ];

  return (
    <div className="overflow-hidden">
      {noRestrictions ? (
        <div className="mb-4 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
          {t("DashboardCustody.policyReviewNoRestrictions")}
        </div>
      ) : null}
      {reviewRows.map((row) => (
        <div
          key={row.label}
          className="flex items-start justify-between gap-5 border-t border-border-default py-4 first:border-t-0"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{row.label}</p>
            <div className="mt-1 text-sm leading-5 text-secondary">
              {row.value ?? t("DashboardCustody.policyNotConfigured")}
            </div>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => onEdit(row.step, row.category)}
          >
            {t("DashboardCustody.policyEdit")}
          </Button>
        </div>
      ))}
      {state.passthroughRules.length > 0 ? (
        <div className="border-t border-border-default bg-surface-sunken py-3 text-xs text-secondary">
          {t("DashboardCustody.policyReviewPreservedRules", {
            count: state.passthroughRules.length,
          })}
        </div>
      ) : null}
    </div>
  );
}
