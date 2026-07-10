"use client";

import { Coins, Flame, type LucideIcon, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  const operationRows: OperationRow[] = ops.canDeployToken
    ? [
        {
          id: "deploy",
          icon: Rocket,
          title: "Deploy token",
          helper: "Deploy this token on-chain before running other fund operations.",
          actionLabel: "Deploy",
          disabled: Boolean(ops.fundManagementDisabledReasons.deploy),
          disabledReason: ops.fundManagementDisabledReasons.deploy,
        },
      ]
    : [
        {
          id: "mint",
          icon: Coins,
          title: "Mint tokens",
          helper: "Create new supply in a destination wallet or token account.",
          actionLabel: "Mint",
          disabled: Boolean(ops.fundManagementDisabledReasons.mint),
          disabledReason: ops.fundManagementDisabledReasons.mint,
        },
        {
          id: "burn",
          icon: Flame,
          title: "Burn tokens",
          helper: "Remove supply from a source wallet or token account.",
          actionLabel: "Burn",
          disabled: Boolean(ops.fundManagementDisabledReasons.burn),
          disabledReason: ops.fundManagementDisabledReasons.burn,
        },
      ];

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-2xl border border-border-default bg-white">
        {operationRows.map((row) => {
          const Icon = row.icon;
          return (
            <div
              key={row.id}
              data-testid={`fund-management-row-${row.id}`}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-5 py-4 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-fill-subtle text-primary">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-base font-medium text-primary">{row.title}</p>
                  <p className="text-sm text-secondary">{row.helper}</p>
                </div>
              </div>
              <TokenDisabledActionTooltip reason={row.disabledReason}>
                <Button
                  type="button"
                  className="w-[112px]"
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
