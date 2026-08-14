// Workflow action catalog ("THEN"). CODE not table. Each action declares how it's gated
// (`requires`) and its execution tier (`execution` → badge + auto/manual policy).
// i18n keys live in dashboard-issuance.json under `DashboardIssuance.workflows`, keyed by
// the action type itself so the catalog and the message files can't drift apart.
// See Phase 5 plan.

import type { WorkflowAction, WorkflowActionType } from "@sdp/types";

const action = (type: string): string => `DashboardIssuance.workflows.actionLabels.${type}`;
const desc = (type: string): string => `DashboardIssuance.workflows.actionDescriptions.${type}`;

export const WORKFLOW_ACTIONS = {
  // ── Automated: safe/reversible, auto-applies ──
  allowlist_add: {
    labelKey: action("allowlist_add"),
    descriptionKey: desc("allowlist_add"),
    requires: { kind: "allowlist" },
    execution: "automated",
    idempotent: true,
  },
  allowlist_remove: {
    labelKey: action("allowlist_remove"),
    descriptionKey: desc("allowlist_remove"),
    requires: { kind: "allowlist" },
    execution: "automated",
    idempotent: true,
  },
  send_webhook: {
    labelKey: action("send_webhook"),
    descriptionKey: desc("send_webhook"),
    requires: { kind: "none" },
    execution: "automated",
    idempotent: false,
  },
  notify: {
    labelKey: action("notify"),
    descriptionKey: desc("notify"),
    requires: { kind: "none" },
    execution: "automated",
    idempotent: false,
  },
  record: {
    labelKey: action("record"),
    descriptionKey: desc("record"),
    requires: { kind: "none" },
    execution: "automated",
    idempotent: true,
  },
  // ── Sensitive: reversible but disruptive; default manual, issuer may opt into auto ──
  pause: {
    labelKey: action("pause"),
    descriptionKey: desc("pause"),
    requires: { kind: "token_transaction", action: "pause" },
    execution: "sensitive",
    idempotent: true,
  },
  unpause: {
    labelKey: action("unpause"),
    descriptionKey: desc("unpause"),
    requires: { kind: "token_transaction", action: "unpause" },
    execution: "sensitive",
    idempotent: true,
  },
  freeze: {
    labelKey: action("freeze"),
    descriptionKey: desc("freeze"),
    requires: { kind: "token_transaction", action: "freeze" },
    execution: "sensitive",
    idempotent: true,
  },
  unfreeze: {
    labelKey: action("unfreeze"),
    descriptionKey: desc("unfreeze"),
    requires: { kind: "token_transaction", action: "unfreeze" },
    execution: "sensitive",
    idempotent: true,
  },
  // ── Requires approval: destructive/irreversible; always manual, never auto ──
  seize: {
    labelKey: action("seize"),
    descriptionKey: desc("seize"),
    requires: { kind: "token_transaction", action: "seize" },
    execution: "requires_approval",
    idempotent: false,
  },
  force_burn: {
    labelKey: action("force_burn"),
    descriptionKey: desc("force_burn"),
    requires: { kind: "token_transaction", action: "force_burn" },
    execution: "requires_approval",
    idempotent: false,
  },
  burn: {
    labelKey: action("burn"),
    descriptionKey: desc("burn"),
    requires: { kind: "base", action: "burn" },
    execution: "requires_approval",
    idempotent: false,
  },
  mint: {
    labelKey: action("mint"),
    descriptionKey: desc("mint"),
    requires: { kind: "base", action: "mint" },
    execution: "requires_approval",
    idempotent: false,
  },
} as const satisfies Record<WorkflowActionType, WorkflowAction>;
