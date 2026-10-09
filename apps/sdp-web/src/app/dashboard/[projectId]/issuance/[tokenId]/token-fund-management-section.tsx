"use client";

import { Button } from "@/components/ui/button";
import { TokenDisabledActionTooltip } from "./token-disabled-action-tooltip";

export type FundManagementModalAction = "mint" | "burn";

// Deploy shows in the fund-management rows but fires immediately (Kora-sponsored)
// instead of opening the shared modal, so each row carries its own action.
export type FundManagementRowId = FundManagementModalAction | "deploy";

export interface FundManagementRow {
  id: FundManagementRowId;
  title: string;
  helper: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
  disabledReason?: string | null;
}

interface TokenFundManagementSectionProps {
  rows: FundManagementRow[];
}

export function TokenFundManagementSection({ rows }: TokenFundManagementSectionProps) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border-default bg-surface-raised">
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
              onClick={row.onAction}
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
