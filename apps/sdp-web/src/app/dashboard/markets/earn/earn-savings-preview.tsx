"use client";

import type { EarnButtonStyle } from "@sdp/types";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { EarnDepositButtonPreview } from "./earn-button-preview";

/**
 * The customer-facing savings card the integration snippet actually builds:
 * balance, total earned, deposit + withdraw, and recent activity (PRO-1772,
 * the Deel-shape reference). Every figure here is a static mock — the preview
 * shows partners the SHAPE their end users get, not live money.
 */
export function EarnSavingsCardPreview({
  accentColor,
  compact = false,
  header,
  style,
}: {
  accentColor: string;
  compact?: boolean;
  header?: ReactNode;
  style: EarnButtonStyle;
}) {
  const t = useTranslations();
  const activity = [
    {
      key: "deposit",
      icon: ArrowDownLeftIcon,
      label: t("DashboardMarkets.earnProgram.savingsActivityDeposit"),
      amount: "+$500.00",
      status: t("DashboardMarkets.earnProgram.savingsActivitySettled"),
    },
    {
      key: "withdrawal",
      icon: ArrowUpRightIcon,
      label: t("DashboardMarkets.earnProgram.savingsActivityWithdrawal"),
      amount: "-$120.00",
      status: t("DashboardMarkets.earnProgram.savingsActivitySettled"),
    },
  ];

  return (
    <div>
      {header}

      <div
        className={cn(
          header ? "border-t border-border-subtle" : null,
          compact ? "mt-4 pt-4" : "mt-5 pt-5"
        )}
      >
        <p className="text-xs text-tertiary">
          {t("DashboardMarkets.earnProgram.savingsBalanceLabel")}
        </p>
        <p
          className={cn(
            "mt-1 font-medium tracking-tight text-primary tabular-nums",
            compact ? "text-xl" : "text-2xl"
          )}
        >
          $1,264.18
        </p>
        <p className="mt-1 text-xs text-secondary tabular-nums">
          {t("DashboardMarkets.earnProgram.savingsEarnedLine", { earned: "+$14.18" })}
        </p>
      </div>

      <div className={cn("grid grid-cols-2 gap-2", compact ? "mt-4" : "mt-5")}>
        <EarnDepositButtonPreview
          accentColor={accentColor}
          className="w-full"
          compact={compact}
          style={style}
        />
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-lg border border-border-default bg-surface-raised font-medium text-primary shadow-sm",
            compact ? "h-8 px-3 text-xs" : "h-11 px-5 text-sm"
          )}
        >
          {t("DashboardMarkets.earnProgram.withdrawButtonLabel")}
        </span>
      </div>
      <p
        className={cn(
          "text-center text-tertiary",
          compact ? "mt-1.5 text-[10px]" : "mt-2 text-[11px]"
        )}
      >
        {t("DashboardMarkets.earnProgram.poweredBy")}
      </p>

      <div className={cn(compact ? "mt-4" : "mt-5")}>
        <p className="text-xs text-tertiary">
          {t("DashboardMarkets.earnProgram.savingsActivityTitle")}
        </p>
        <ul className="mt-2 space-y-2">
          {activity.map((row) => {
            const Icon = row.icon;
            return (
              <li className="flex items-center gap-2.5" key={row.key}>
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-fill-subtle">
                  <Icon aria-hidden="true" className="size-3.5 text-secondary" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-primary">
                    {row.label}
                  </span>
                  <span className="block text-[10px] text-tertiary">{row.status}</span>
                </span>
                <span className="text-xs text-secondary tabular-nums">{row.amount}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
