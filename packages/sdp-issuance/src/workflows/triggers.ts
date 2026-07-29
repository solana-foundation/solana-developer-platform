// Workflow trigger catalog ("WHEN"). CODE not table (no migration to add a trigger).
// i18n keys in dashboard-issuance.json under `DashboardWorkflows.trigger`.
// See Phase 5 plan.

import type { WorkflowTrigger, WorkflowTriggerType } from "@sdp/types";

const trigger = (leaf: string): string => `DashboardWorkflows.trigger.${leaf}`;
const desc = (leaf: string): string => trigger(`${leaf}Description`);

// v1: all triggers are internal events SDP emits after processing a provider webhook
// or cron pass. `external_webhook`-sourced triggers plug in later with no engine change.
export const WORKFLOW_TRIGGERS = {
  kyc_approved: {
    labelKey: trigger("kycApproved"),
    descriptionKey: desc("kycApproved"),
    source: "internal_event",
    conditionFields: ["provider", "counterpartyKind"],
  },
  kyc_rejected: {
    labelKey: trigger("kycRejected"),
    descriptionKey: desc("kycRejected"),
    source: "internal_event",
    conditionFields: ["provider", "counterpartyKind"],
  },
  onramp_settled: {
    labelKey: trigger("onrampSettled"),
    descriptionKey: desc("onrampSettled"),
    source: "internal_event",
    conditionFields: ["provider", "fiatCurrency", "cryptoToken"],
  },
  offramp_settled: {
    labelKey: trigger("offrampSettled"),
    descriptionKey: desc("offrampSettled"),
    source: "internal_event",
    conditionFields: ["provider", "fiatCurrency", "cryptoToken"],
  },
  recurring_payment_failed: {
    labelKey: trigger("recurringPaymentFailed"),
    descriptionKey: desc("recurringPaymentFailed"),
    source: "internal_event",
    conditionFields: ["attempt"],
  },
  token_operation_completed: {
    labelKey: trigger("tokenOperationCompleted"),
    descriptionKey: desc("tokenOperationCompleted"),
    source: "internal_event",
    conditionFields: ["operation"],
  },
} as const satisfies Record<WorkflowTriggerType, WorkflowTrigger>;
