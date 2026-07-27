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
