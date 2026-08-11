import type { TokenTransactionType } from "./tokens";

export const WORKFLOW_TRIGGER_TYPES = [
  "kyc_approved",
  "kyc_rejected",
  "onramp_settled",
  "offramp_settled",
  "recurring_payment_failed",
  "token_operation_completed",
] as const;
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

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

/**
 * `automated` runs unattended; `sensitive` defaults to manual review but the
 * issuer may opt into auto; `requires_approval` is always manual and can never
 * be configured to auto-run.
 */
export type WorkflowExecutionTier = "automated" | "sensitive" | "requires_approval";

export type ReviewMode = "auto" | "manual";

/**
 * Shapes only — catalog data and validation live in `@sdp/issuance/workflows`
 * to avoid a circular import between `@sdp/types` and `@sdp/issuance`.
 */
export interface WorkflowTrigger {
  labelKey: string;
  descriptionKey: string;
  source: "internal_event" | "external_webhook";
  /** Fields guards may filter on — operational only, never eligibility. */
  conditionFields: readonly string[];
}

export type WorkflowActionRequirement =
  /** Token-2022 op unlocked by an enabled AdvancedSetting. */
  | { kind: "token_transaction"; action: TokenTransactionType }
  | { kind: "allowlist" }
  /** Base op on any deployed token; finer checks happen at execution time. */
  | { kind: "base"; action: TokenTransactionType }
  | { kind: "none" };

export interface WorkflowAction {
  labelKey: string;
  descriptionKey: string;
  requires: WorkflowActionRequirement;
  execution: WorkflowExecutionTier;
  idempotent: boolean;
}

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
  /** Stamped with WORKFLOW_RULE_VERSION; bump if the definition shape changes. */
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
