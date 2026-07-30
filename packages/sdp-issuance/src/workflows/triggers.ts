// Workflow trigger catalog ("WHEN"). CODE not table (no migration to add a trigger).
// i18n keys live in dashboard-issuance.json under `DashboardIssuance.workflows`, keyed by
// the trigger type itself so the catalog and the message files can't drift apart.
// See Phase 5 plan.

import type { WorkflowTrigger, WorkflowTriggerType } from "@sdp/types";

const trigger = (type: string): string => `DashboardIssuance.workflows.triggerLabels.${type}`;
const desc = (type: string): string => `DashboardIssuance.workflows.triggerDescriptions.${type}`;

// v1: all triggers are internal events SDP emits after processing a provider webhook
// or cron pass. `external_webhook`-sourced triggers plug in later with no engine change.
export const WORKFLOW_TRIGGERS = {
  kyc_approved: {
    labelKey: trigger("kyc_approved"),
    descriptionKey: desc("kyc_approved"),
    source: "internal_event",
    conditionFields: ["provider", "counterpartyKind"],
  },
  kyc_rejected: {
    labelKey: trigger("kyc_rejected"),
    descriptionKey: desc("kyc_rejected"),
    source: "internal_event",
    conditionFields: ["provider", "counterpartyKind"],
  },
  onramp_settled: {
    labelKey: trigger("onramp_settled"),
    descriptionKey: desc("onramp_settled"),
    source: "internal_event",
    conditionFields: ["provider", "fiatCurrency", "cryptoToken"],
  },
  offramp_settled: {
    labelKey: trigger("offramp_settled"),
    descriptionKey: desc("offramp_settled"),
    source: "internal_event",
    conditionFields: ["provider", "fiatCurrency", "cryptoToken"],
  },
  recurring_payment_failed: {
    labelKey: trigger("recurring_payment_failed"),
    descriptionKey: desc("recurring_payment_failed"),
    source: "internal_event",
    conditionFields: ["attempt"],
  },
  token_operation_completed: {
    labelKey: trigger("token_operation_completed"),
    descriptionKey: desc("token_operation_completed"),
    source: "internal_event",
    conditionFields: ["operation"],
  },
} as const satisfies Record<WorkflowTriggerType, WorkflowTrigger>;
