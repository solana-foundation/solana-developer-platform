"use client";

import { Button } from "@/components/ui/button";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";

export type FundManagementModalAction = "deploy" | "mint" | "burn";

export interface FundManagementRow {
  id: FundManagementModalAction;
  title: string;
  helper: string;
  actionLabel: string;
  disabled?: boolean;
  disabledReason?: string | null;
}

interface TokenFundManagementSectionProps {
  rows: FundManagementRow[];
  onOpenAction: (action: FundManagementModalAction) => void;
}

export function TokenFundManagementSection({
  rows,
  onOpenAction,
}: TokenFundManagementSectionProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-white">
      {rows.map((row) => (
        <div
          key={row.id}
          data-testid={`fund-management-row-${row.id}`}
          className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0"
        >
          <div>
            <p className="text-[17px] font-medium text-primary">{row.title}</p>
            <p className="text-sm text-secondary">{row.helper}</p>
          </div>
          <TokenDisabledActionTooltip reason={row.disabledReason}>
            <Button
              type="button"
              className="w-[112px]"
              onClick={() => onOpenAction(row.id)}
              disabled={row.disabled}
            >
              {row.actionLabel}
            </Button>
          </TokenDisabledActionTooltip>
        </div>
      ))}
    </section>
  );
}
