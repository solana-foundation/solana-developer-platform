"use client";

import type { AssetAuditActorType, AssetAuditEvent } from "@sdp/types";
import {
  Activity,
  Ban,
  CirclePlus,
  Coins,
  Flame,
  Gavel,
  KeyRound,
  type LucideIcon,
  Pause,
  Play,
  Rocket,
  Snowflake,
  SquarePen,
  Sun,
} from "lucide-react";
import type { MessageKey } from "@/i18n/messages";
import { formatDisplayLabel } from "@/lib/utils";
import { ACTION_ICONS } from "./tabs/workflow-builder-cards";

type Translate = (key: MessageKey) => string;

/** Human-readable action label, e.g. "update_authority" → "Update authority". */
export function auditActionLabel(action: string): string {
  const label = formatDisplayLabel(action);
  // formatDisplayLabel title-cases every word; keep only the first capital so
  // labels read as sentence case ("Force burn", not "Force Burn").
  return label.charAt(0) + label.slice(1).toLowerCase();
}

// Per-operation glyph. Covers the asset-management actions; anything else
// (transaction/auth lifecycle actions surfaced in the full log) falls back to
// the neutral Activity mark so the badge shape stays uniform.
const AUDIT_ACTION_ICONS: Record<string, LucideIcon> = {
  deploy: Rocket,
  mint: Coins,
  burn: Flame,
  force_burn: Flame,
  freeze: Snowflake,
  unfreeze: Sun,
  seize: Gavel,
  update_authority: KeyRound,
  pause: Pause,
  unpause: Play,
  create: CirclePlus,
  update: SquarePen,
  revoke: Ban,
};

export function auditActionIcon(action: string): LucideIcon {
  return AUDIT_ACTION_ICONS[action] ?? Activity;
}

// Every engine-run row logs the same two actions, so on their own they read as a wall of
// "Workflow action executed" — the action that actually ran is in the metadata the engine
// already writes (`actionType`). The Type column says these came from a workflow, so the
// Action column is free to name the operation instead of repeating the category.
const WORKFLOW_AUDIT_ACTIONS = new Set(["workflow_action_executed", "workflow_action_failed"]);

function workflowActionType(event: AssetAuditEvent): string | null {
  if (!WORKFLOW_AUDIT_ACTIONS.has(event.action)) {
    return null;
  }
  const actionType = event.metadata?.actionType;
  return typeof actionType === "string" && actionType.length > 0 ? actionType : null;
}

/** Row label: the workflow's own action when there is one, else the audit action. */
export function auditEventActionLabel(event: AssetAuditEvent, t: Translate): string {
  const actionType = workflowActionType(event);
  if (!actionType) {
    return auditActionLabel(event.action);
  }
  try {
    // The builder's catalog labels, so one action reads identically in both places.
    return t(`DashboardIssuance.workflows.actionLabels.${actionType}` as MessageKey);
  } catch {
    // An action the client's catalog doesn't know still names itself.
    return auditActionLabel(actionType);
  }
}

export function auditEventActionIcon(event: AssetAuditEvent): LucideIcon {
  const actionType = workflowActionType(event);
  return (actionType ? ACTION_ICONS[actionType] : undefined) ?? auditActionIcon(event.action);
}

// Status carries the only color — SDP semantic badge tokens (borderless pill).
export function auditStatusBadgeClass(status: AssetAuditEvent["status"]): string {
  return status === "failure" ? "bg-error-bg text-error" : "bg-success-bg text-success";
}

// Actor-type chip. `system` (automated/workflow) is the only tinted one, echoing
// the design sketch's green "Workflow" tag; human/API actors stay neutral gray.
export function auditActorBadgeClass(actorType: AssetAuditActorType): string {
  return actorType === "system" ? "bg-success-bg text-success" : "bg-fill text-secondary";
}

export function auditActorTypeLabel(actorType: AssetAuditActorType, t: Translate): string {
  switch (actorType) {
    case "system":
      return t("DashboardIssuance.activity.actorWorkflow");
    case "api_key":
      return t("DashboardIssuance.activity.actorApiKey");
    default:
      return t("DashboardIssuance.activity.actorUser");
  }
}
