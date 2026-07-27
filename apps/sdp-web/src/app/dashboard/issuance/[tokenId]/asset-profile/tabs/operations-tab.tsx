"use client";

import { Coins, Flame, type LucideIcon, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import type { FundManagementModalAction } from "../../token-fund-management-section";
import { TokenTransactionsSection } from "../../token-transactions-section";
import type { TokenOperations } from "../use-token-operations";

interface OperationRow {
  id: FundManagementModalAction;
  icon: LucideIcon;
  title: string;
  helper: string;
  actionLabel: string;
  disabled: boolean;
  disabledReason: string | null;
}

export function OperationsTab({ ops }: { ops: TokenOperations }) {
  const t = useTranslations();
  const operationRows: OperationRow[] = ops.canDeployToken
    ? [
        {
          id: "deploy",
          icon: Rocket,
          title: t("DashboardIssuance.management.deployToken"),
          helper: t("DashboardIssuance.operations.deployHelper"),
          actionLabel: t("DashboardIssuance.header.deploy"),
          disabled: Boolean(ops.fundManagementDisabledReasons.deploy),
          disabledReason: ops.fundManagementDisabledReasons.deploy,
        },
      ]
    : [
        {
          id: "mint",
          icon: Coins,
          title: t("DashboardIssuance.management.mintTokens"),
          helper: t("DashboardIssuance.management.mintHelper"),
          actionLabel: t("DashboardIssuance.management.mint"),
          disabled: Boolean(ops.fundManagementDisabledReasons.mint),
          disabledReason: ops.fundManagementDisabledReasons.mint,
        },
        {
          id: "burn",
          icon: Flame,
          title: t("DashboardIssuance.management.burnTokens"),
          helper: t("DashboardIssuance.management.burnHelper"),
          actionLabel: t("DashboardIssuance.management.burn"),
          disabled: Boolean(ops.fundManagementDisabledReasons.burn),
          disabledReason: ops.fundManagementDisabledReasons.burn,
        },
      ];

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <p className="text-base font-medium text-primary">
            {t("DashboardIssuance.management.operations")}
          </p>
          <p className="mt-0.5 text-sm text-tertiary">
            {t("DashboardIssuance.operations.subtitle")}
          </p>
        </div>

        {/* Single deploy action spans full width; mint + burn sit side by side. */}
        <div className={cn("grid gap-4", operationRows.length > 1 && "sm:grid-cols-2")}>
          {operationRows.map((row) => {
            const Icon = row.icon;
            return (
              <div
                key={row.id}
                data-testid={`fund-management-row-${row.id}`}
                className="flex items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised p-5"
              >
                <div className="flex min-w-0 items-center gap-3.5">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-fill-subtle text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-primary">{row.title}</p>
                    <p className="mt-0.5 text-sm text-secondary">{row.helper}</p>
                  </div>
                </div>
                <TokenDisabledActionTooltip reason={row.disabledReason}>
                  <Button
                    type="button"
                    className="w-[96px]"
                    onClick={() => ops.openFundManagementModal(row.id)}
                    disabled={row.disabled}
                  >
                    {row.actionLabel}
                  </Button>
                </TokenDisabledActionTooltip>
              </div>
            );
          })}
        </div>
      </div>

      <TokenTransactionsSection
        transactions={ops.transactions}
        transactionsError={ops.transactionsError}
        transactionsTotal={ops.transactionsTotal}
        transactionsHasMore={ops.transactionsHasMore}
        isLoading={ops.supportingDataLoading}
      />
    </div>
  );
}
