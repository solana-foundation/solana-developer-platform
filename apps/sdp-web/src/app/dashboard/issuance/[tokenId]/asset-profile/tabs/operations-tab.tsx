"use client";

import type { Token } from "@sdp/types";
import { Coins, Flame, type LucideIcon, Rocket, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import type { FundManagementModalAction } from "../../token-fund-management-section";
import type { AdminAction } from "../../token-management-workspace.types";
import { TokenTransactionsSection } from "../../token-transactions-section";
import type { TokenOperations } from "../use-token-operations";
import { ActionPills } from "./action-pills";
import { OpsActionForms } from "./ops-action-forms";

interface OperationRow {
  id: FundManagementModalAction;
  icon: LucideIcon;
  title: string;
  helper: string;
  actionLabel: string;
  disabled: boolean;
  disabledReason: string | null;
}

export function OperationsTab({
  token,
  ops,
  canManageTokenAdmin,
}: {
  token: Token;
  ops: TokenOperations;
  canManageTokenAdmin: boolean;
}) {
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

  const adminActions: Array<{ id: AdminAction; label: string }> = canManageTokenAdmin
    ? [
        { id: "seize", label: "Force transfer" },
        { id: "force-burn", label: "Force burn" },
      ]
    : [];
  const [activeAdminAction, setActiveAdminAction] = useState<AdminAction | null>(null);

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white">
        {operationRows.map((row) => {
          const Icon = row.icon;
          return (
            <div
              key={row.id}
              data-testid={`fund-management-row-${row.id}`}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(28,28,29,0.08)] px-5 py-4 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3.5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-base font-medium text-[#1c1c1d]">{row.title}</p>
                  <p className="text-sm text-[rgba(28,28,29,0.62)]">{row.helper}</p>
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

      {adminActions.length > 0 && !ops.canDeployToken ? (
        <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.05)] text-[#1c1c1d]">
              <ShieldAlert className="h-4.5 w-4.5" />
            </span>
            <div>
              <p className="text-base font-medium text-[#1c1c1d]">Administrative actions</p>
              <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.58)]">
                Force transfer or burn tokens from any account using the permanent delegate.
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-4">
            <ActionPills
              actions={adminActions}
              activeAction={activeAdminAction}
              disabledReasons={ops.complianceActionDisabledReasons}
              onSelectAction={(action) =>
                setActiveAdminAction((current) => (current === action ? null : action))
              }
            />
            {activeAdminAction ? (
              <OpsActionForms ops={ops} token={token} activeAction={activeAdminAction} />
            ) : null}
          </div>
        </div>
      ) : null}

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
