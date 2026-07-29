// Workflow Builder domain: declarative "WHEN X → THEN Y (GUARD Z)" automations on assets.
// SHAPES ONLY — the trigger/action catalog and validation logic live in
// @sdp/issuance/workflows (mirrors advanced-settings ↔ capabilities split to avoid
// the @sdp/types ↔ @sdp/issuance circular import). See Phase 5 plan.

import type { TokenTransactionType } from "./tokens";

// ── Vocabulary (stable string keys; validated app-side, stored as open TEXT) ──

// Triggers ("WHEN"). v1 sources are all internal events SDP emits after processing
// provider webhooks / cron; `external_webhook` is the documented future source.
export const WORKFLOW_TRIGGER_TYPES = [
  "kyc_approved",
  "kyc_rejected",
  "onramp_settled",
  "offramp_settled",
  "recurring_payment_failed",
  "token_operation_completed",
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

// Actions ("THEN"). On-chain ops are gated by capability; side-effects are always available.
export const WORKFLOW_ACTION_TYPES = [
  "allowlist_add",
  "allowlist_remove",
  "send_webhook",
  "notify",
  "record",
  "pause",
  "unpause",
  "freeze",
  "unfreeze",
  "seize",
  "force_burn",
  "burn",
  "mint",
] as const;
export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

// Execution tier → UI badge + auto/manual policy:
//  automated         → runs unattended (green "Automated")
//  sensitive         → reversible but disruptive; defaults to manual review, issuer may opt into auto (amber "Sensitive")
//  requires_approval → destructive/irreversible; always manual, can never be auto (red "Requires approval")
export type WorkflowExecutionTier = "automated" | "sensitive" | "requires_approval";

// Auto-apply vs hold for a human. Enrollments and rules share this shape.
export type ReviewMode = "auto" | "manual";

// ── Catalog entry shapes (CODE, defined in @sdp/issuance/workflows) ──

export interface WorkflowTrigger {
  labelKey: string;
  descriptionKey: string;
  // Where the trigger event originates. v1 = internal_event.
  source: "internal_event" | "external_webhook";
  // Fields the UI can offer GUARD conditions over (operational filters only — never
  // legally load-bearing eligibility, which gates emission upstream).
  conditionFields: readonly string[];
}

// How an action is authorized against the asset's capabilities.
export type WorkflowActionRequirement =
  // Maps to a Token-2022 op unlocked by an enabled AdvancedSetting (`ADVANCED_SETTINGS[key].actions`).
  | { kind: "token_transaction"; action: TokenTransactionType }
  // Requires the token to have an allowlist (ablListAddress set).
  | { kind: "allowlist" }
  // Base on-chain op available on any deployed token (e.g. mint/burn) — no advanced-setting
  // gate; finer runtime checks (deployed, authority still held) happen at execution time.
  | { kind: "base"; action: TokenTransactionType }
  // Pure side-effect (webhook, notify, record, approval task) — no capability gate.
  | { kind: "none" };

export interface WorkflowAction {
  labelKey: string;
  descriptionKey: string;
  requires: WorkflowActionRequirement;
  execution: WorkflowExecutionTier;
  // Whether re-running the action on the same target is a safe no-op (drives safe manual retries).
  idempotent: boolean;
}

// ── Rule instance (stored row projection) ──

// GUARD: a flat AND of simple field comparisons over the trigger payload.
export interface WorkflowCondition {
  all: ReadonlyArray<{
    field: string;
    op: "eq" | "neq" | "in";
    value: string | number | ReadonlyArray<string | number>;
  }>;
}

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  retryAfterMinutes: number;
}

export interface WorkflowRuleAction {
  type: WorkflowActionType;
  // Static params (e.g. label to stamp on an allowlist entry, webhook URL).
  params: Record<string, string | number>;
}

export interface WorkflowRule {
  id: string;
  organizationId: string;
  projectId: string;
  tokenId: string;
  trigger: { type: WorkflowTriggerType };
  condition: WorkflowCondition | null;
  action: WorkflowRuleAction;
  enabled: boolean;
  reviewMode: ReviewMode;
  retryPolicy: WorkflowRetryPolicy;
  // Stamped with WORKFLOW_RULE_VERSION; bump if the definition shape changes.
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Execution ledger ──

export const WORKFLOW_EXECUTION_STATUSES = [
  "awaiting_review",
  "pending",
  "processing",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type WorkflowExecutionStatus = (typeof WORKFLOW_EXECUTION_STATUSES)[number];

export interface WorkflowExecution {
  id: string;
  organizationId: string;
  projectId: string;
  workflowId: string;
  tokenId: string;
  triggerType: WorkflowTriggerType;
  actionType: WorkflowActionType;
  status: WorkflowExecutionStatus;
  idempotencyKey: string;
  triggerPayload: Record<string, unknown>;
  result: Record<string, unknown>;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lockedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
