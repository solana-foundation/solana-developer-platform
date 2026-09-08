"use client";

import type { Token } from "@sdp/types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import { AnimatedSection } from "../animated-section";
import type { TokenOperations } from "../use-token-operations";
import {
  getOperationGroups,
  getOperationLabels,
  type OperationAction,
  type OperationRow,
} from "./operation-rows.model";
import { OpsActionForms } from "./ops-action-forms";

export function OperationsTab({
  ops,
  token,
  canManageTokenAdmin,
}: {
  ops: TokenOperations;
  token: Token;
  canManageTokenAdmin: boolean;
}) {
  const t = useTranslations();
  const [activeAction, setActiveAction] = useState<OperationAction | null>(null);
  const labels = getOperationLabels(token, t);
  const { supply, transfers, recovery } = getOperationGroups({
    ops,
    token,
    canManageTokenAdmin,
    t,
    onSelect: setActiveAction,
    labels,
  });

  return (
    <div className="w-full space-y-6">
      <OperationGroup
        title={t("DashboardIssuance.simplified.supply")}
        rows={supply}
        pending={ops.isPending}
      />
      <OperationGroup
        title={t("DashboardIssuance.simplified.transfers")}
        rows={transfers}
        pending={ops.isPending}
      />
      {recovery.length ? (
        <AnimatedSection
          title={t("DashboardIssuance.simplified.recovery")}
          className="border-t border-border-subtle pt-5"
        >
          <p className="mt-2 text-sm text-tertiary">
            {t("DashboardIssuance.simplified.recoveryHint")}
          </p>
          <OperationRows rows={recovery} pending={ops.isPending} />
        </AnimatedSection>
      ) : null}
      <Modal
        isOpen={Boolean(activeAction)}
        ariaLabel={
          activeAction ? labels[activeAction] : t("DashboardIssuance.management.operations")
        }
        onClose={() => setActiveAction(null)}
        closeDisabled={ops.isPending}
        size="xl"
        contentClassName="p-6 [&_[data-slot=card-header]]:pr-10"
      >
        {activeAction ? (
          <OpsActionForms
            token={token}
            activeAction={activeAction}
            ops={{
              ...ops,
              handleSeize: () => {
                setActiveAction(null);
                ops.handleSeize();
              },
              handleForceBurn: () => {
                setActiveAction(null);
                ops.handleForceBurn();
              },
              handleFreeze: (freeze) => {
                setActiveAction(null);
                ops.handleFreeze(freeze);
              },
            }}
            formVariant="bare"
            submitAlignment="end"
          />
        ) : null}
      </Modal>
    </div>
  );
}

function OperationGroup({
  title,
  rows,
  pending,
}: {
  title: string;
  rows: OperationRow[];
  pending: boolean;
}) {
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-tertiary">{title}</h3>
      <OperationRows rows={rows} pending={pending} />
    </section>
  );
}

function OperationRows({ rows, pending }: { rows: OperationRow[]; pending: boolean }) {
  const t = useTranslations();
  return (
    <div className="divide-y divide-border-subtle">
      {rows.map(({ icon: Icon, ...row }) => (
        <div
          key={row.id}
          data-testid={`fund-management-row-${row.id}`}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 sm:grid-cols-[20px_minmax(0,1fr)_auto] sm:gap-4 sm:py-4"
        >
          <Icon className="hidden size-5 shrink-0 text-secondary sm:block" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{row.title}</p>
            <p className="mt-1 hidden text-sm text-tertiary sm:block">{row.helper}</p>
          </div>
          <TokenDisabledActionTooltip reason={row.disabledReason}>
            <Button
              variant="secondary"
              size="sm"
              aria-label={row.title}
              className="min-w-20"
              disabled={pending || Boolean(row.disabledReason)}
              onClick={row.onAction}
            >
              {row.actionLabel ?? t("DashboardIssuance.simplified.open")}
            </Button>
          </TokenDisabledActionTooltip>
        </div>
      ))}
    </div>
  );
}
