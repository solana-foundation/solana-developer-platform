"use client";

import type { Token } from "@sdp/types";
import {
  ArrowRightLeft,
  ChevronDown,
  Coins,
  Flame,
  Lock,
  type LucideIcon,
  Pause,
  Play,
  ShieldCheck,
  Snowflake,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { TokenDisabledActionTooltip } from "../../token-disabled-action-tooltip";
import type { TokenOperations } from "../use-token-operations";
import { OpsActionForms } from "./ops-action-forms";

interface OperationRow {
  id: string;
  icon: LucideIcon;
  title: string;
  helper: string;
  actionLabel?: string;
  onAction: () => void;
  disabledReason?: string | null;
}

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
  const [activeAction, setActiveAction] = useState<
    "allowlist" | "freeze" | "seize" | "force-burn" | null
  >(null);
  const labels = {
    allowlist: t(
      token.requiresAllowlist
        ? "DashboardIssuance.simplified.approvedRecipients"
        : "DashboardIssuance.simplified.blockedRecipients"
    ),
    freeze: t("DashboardIssuance.simplified.freeze"),
    seize: t("DashboardIssuance.compliance.forceTransfer"),
    "force-burn": t("DashboardIssuance.compliance.forceBurn"),
  };
  const availability = ops.operationAvailability;

  const draftReason = !token.mintAddress ? t("DashboardIssuance.simplified.deployFirst") : null;
  const isStablecoinDraft = !token.mintAddress && token.template === "stablecoin";

  const supply: OperationRow[] = [
    {
      id: "mint",
      icon: Coins,
      title: t("DashboardIssuance.management.mintTokens"),
      helper: t("DashboardIssuance.simplified.mintHint"),
      actionLabel: t("DashboardIssuance.management.mint"),
      onAction: () => ops.openFundManagementModal("mint"),
      disabledReason: availability.mint,
    },
    {
      id: "burn",
      icon: Flame,
      title: t("DashboardIssuance.management.burnTokens"),
      helper: t("DashboardIssuance.simplified.burnHint"),
      actionLabel: t("DashboardIssuance.management.burn"),
      onAction: () => ops.openFundManagementModal("burn"),
      disabledReason: availability.burn,
    },
  ];
  const transfers: OperationRow[] = [];
  if (ops.showControlList)
    transfers.push({
      id: "allowlist",
      icon: ShieldCheck,
      title: labels.allowlist,
      helper: t(
        token.requiresAllowlist
          ? "DashboardIssuance.simplified.approvedHint"
          : "DashboardIssuance.simplified.blockedHint"
      ),
      actionLabel: t("DashboardIssuance.simplified.manage"),
      onAction: () => setActiveAction("allowlist"),
      // Keep the list readable even when its mutation signer is unavailable.
    });
  if (
    canManageTokenAdmin &&
    (token.extensions?.pausable || token.status === "paused" || isStablecoinDraft)
  )
    transfers.push({
      id: "pause",
      icon: token.status === "paused" ? Play : Pause,
      title: t(
        token.status === "paused"
          ? "DashboardIssuance.simplified.resume"
          : "DashboardIssuance.simplified.pause"
      ),
      helper: t(
        token.status === "paused"
          ? "DashboardIssuance.simplified.resumeHint"
          : "DashboardIssuance.simplified.pauseHint"
      ),
      onAction: () => ops.handlePause(token.status !== "paused"),
      actionLabel: t(
        token.status === "paused"
          ? "DashboardIssuance.simplified.resumeAction"
          : "DashboardIssuance.simplified.pauseAction"
      ),
      disabledReason: ops.effectivePauseDisabledReason,
    });
  if (canManageTokenAdmin && token.isFreezable)
    transfers.push({
      id: "freeze",
      icon: Snowflake,
      title: labels.freeze,
      actionLabel: t("DashboardIssuance.simplified.manage"),
      helper: t("DashboardIssuance.simplified.freezeHint"),
      onAction: () => setActiveAction("freeze"),
      disabledReason: ops.effectiveFreezeDisabledReason,
    });
  const recovery: OperationRow[] = [];
  if (canManageTokenAdmin && (token.extensions?.permanentDelegate || isStablecoinDraft))
    recovery.push(
      {
        id: "seize",
        icon: ArrowRightLeft,
        title: labels.seize,
        actionLabel: t("DashboardIssuance.simplified.recoverAction"),
        helper: t("DashboardIssuance.simplified.forceTransferHint"),
        onAction: () => setActiveAction("seize"),
        disabledReason: availability.seize,
      },
      {
        id: "force-burn",
        icon: Flame,
        title: labels["force-burn"],
        actionLabel: t("DashboardIssuance.management.burn"),
        helper: t("DashboardIssuance.simplified.forceBurnHint"),
        onAction: () => setActiveAction("force-burn"),
        disabledReason: availability["force-burn"],
      }
    );
  if (canManageTokenAdmin && ops.lockSupplyRemaining !== null)
    recovery.push({
      id: "lock-supply",
      icon: Lock,
      title: t("DashboardIssuance.management.lockSupplyTitle"),
      actionLabel: t("DashboardIssuance.simplified.lockAction"),
      helper: t("DashboardIssuance.management.lockSupplyHelper"),
      onAction: ops.openLockSupplyModal,
      disabledReason: ops.lockSupplyDisabledReason,
    });

  if (draftReason) {
    for (const row of [...supply, ...transfers, ...recovery]) row.disabledReason = draftReason;
  }

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
        <details className="group border-t border-border-subtle pt-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-secondary [&::-webkit-details-marker]:hidden">
            {t("DashboardIssuance.simplified.recovery")}
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-2 text-sm text-tertiary">
            {t("DashboardIssuance.simplified.recoveryHint")}
          </p>
          <OperationRows rows={recovery} pending={ops.isPending} />
        </details>
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
  const t = useTranslations();
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-tertiary">{title}</h3>
      {rows.length ? (
        <OperationRows rows={rows} pending={pending} />
      ) : (
        <p className="py-4 text-sm text-secondary">
          {t("DashboardIssuance.simplified.noTransferControls")}
        </p>
      )}
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
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4 sm:grid-cols-[20px_minmax(0,1fr)_auto] sm:gap-4 sm:py-5"
        >
          <Icon className="hidden size-5 shrink-0 text-secondary sm:block" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{row.title}</p>
            <p className="mt-1 text-sm text-secondary">{row.helper}</p>
          </div>
          <TokenDisabledActionTooltip reason={row.disabledReason}>
            <Button
              variant="secondary"
              size="sm"
              aria-label={row.title}
              style={{ width: 100 }}
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
