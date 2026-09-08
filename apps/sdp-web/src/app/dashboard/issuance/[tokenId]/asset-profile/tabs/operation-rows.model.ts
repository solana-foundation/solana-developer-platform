import type { Token } from "@sdp/types";
import {
  ArrowRightLeft,
  Coins,
  Flame,
  Lock,
  type LucideIcon,
  Pause,
  Play,
  ShieldCheck,
  Snowflake,
} from "lucide-react";

import type { useTranslations } from "@/i18n/provider";
import type { TokenOperations } from "../use-token-operations";

export type OperationAction = "allowlist" | "freeze" | "seize" | "force-burn";
export interface OperationRow {
  id: string;
  icon: LucideIcon;
  title: string;
  helper: string;
  actionLabel?: string;
  onAction: () => void;
  disabledReason?: string | null;
}

type Translate = ReturnType<typeof useTranslations>;

export function getOperationLabels(token: Token, t: Translate) {
  return {
    allowlist: t(
      token.requiresAllowlist
        ? "DashboardIssuance.simplified.approvedRecipients"
        : "DashboardIssuance.simplified.blockedRecipients"
    ),
    freeze: t("DashboardIssuance.simplified.freeze"),
    seize: t("DashboardIssuance.compliance.forceTransfer"),
    "force-burn": t("DashboardIssuance.compliance.forceBurn"),
  };
}

interface OperationContext {
  ops: TokenOperations;
  token: Token;
  canManageTokenAdmin: boolean;
  t: Translate;
  onSelect: (action: OperationAction) => void;
  labels: ReturnType<typeof getOperationLabels>;
}

function supplyRows({ ops, t }: OperationContext) {
  const availability = ops.operationAvailability;
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

  return supply;
}

function transferRows({ ops, token, t, canManageTokenAdmin, onSelect, labels }: OperationContext) {
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
      onAction: () => onSelect("allowlist"),
      // Keep the list readable even when its mutation signer is unavailable.
    });
  if (
    canManageTokenAdmin &&
    (token.extensions?.pausable || token.status === "paused" || token.template === "stablecoin")
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
      onAction: () => onSelect("freeze"),
      disabledReason: ops.effectiveFreezeDisabledReason,
    });

  return transfers;
}

function recoveryRows({ ops, token, t, canManageTokenAdmin, onSelect, labels }: OperationContext) {
  const isStablecoinDraft = !token.mintAddress && token.template === "stablecoin";
  const availability = ops.operationAvailability;
  const recovery: OperationRow[] = [];
  if (canManageTokenAdmin && (token.extensions?.permanentDelegate || isStablecoinDraft))
    recovery.push(
      {
        id: "seize",
        icon: ArrowRightLeft,
        title: labels.seize,
        actionLabel: t("DashboardIssuance.simplified.recoverAction"),
        helper: t("DashboardIssuance.simplified.forceTransferHint"),
        onAction: () => onSelect("seize"),
        disabledReason: availability.seize,
      },
      {
        id: "force-burn",
        icon: Flame,
        title: labels["force-burn"],
        actionLabel: t("DashboardIssuance.management.burn"),
        helper: t("DashboardIssuance.simplified.forceBurnHint"),
        onAction: () => onSelect("force-burn"),
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

  return recovery;
}

export function getOperationGroups(context: OperationContext) {
  const supply = supplyRows(context);
  const transfers = transferRows(context);
  const recovery = recoveryRows(context);
  if (!context.token.mintAddress) {
    const reason = context.t("DashboardIssuance.simplified.deployFirst");
    for (const row of [...supply, ...transfers, ...recovery]) row.disabledReason = reason;
  }
  return { supply, transfers, recovery };
}
