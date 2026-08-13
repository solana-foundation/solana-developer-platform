"use client";

// Client data layer for the Workflows tab. Talks to the Next proxy routes under
// /api/dashboard/issuance/tokens/:tokenId/workflows (which forward to sdp-api).
// The API returns snake_case rows in a { data, meta } envelope.

export type ExecutionTier = "automated" | "sensitive" | "requires_approval";

export interface WorkflowRuleView {
  id: string;
  token_id: string;
  trigger_type: string;
  action_type: string;
  enabled: boolean;
  review_mode: "auto" | "manual";
  // Full rule definition — the builder reads condition + action.params when editing.
  definition?: {
    condition?: GuardCondition | null;
    action?: { type: string; params?: Record<string, string | number> };
  };
  created_at: string;
}

export type ExecutionStatus =
  | "awaiting_review"
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExecutionView {
  id: string;
  workflow_id: string;
  trigger_type: string;
  action_type: string;
  status: ExecutionStatus;
  attempt_count: number;
  max_attempts: number;
  error: string | null;
  // What the action will do, projected server-side to a documented field list. Held
  // executions render this before the approve control — approving a mint or seize
  // without seeing its target wallet and amount is approving blind.
  trigger_payload?: Record<string, string | number> | null;
  result?: Record<string, string | number | boolean> | null;
  decided_by?: string | null;
  decided_at?: string | null;
  created_at: string;
  updated_at: string;
}

// An enrolled holder (kyc wallet ↔ asset), from GET /holders.
export interface HolderView {
  id: string;
  wallet_address: string;
  kyc_status: string;
  status: string;
  created_at: string;
}

export interface CatalogTriggerView {
  type: string;
  // `conditionFields` are the payload fields the trigger exposes for GUARD ("only if…")
  // filters — the API already sends them; the builder reads them to offer field options.
  trigger: { labelKey: string; descriptionKey: string; conditionFields: string[] };
}

// How an action is authorized against the asset (mirrors WorkflowActionRequirement in
// @sdp/types). Drives the live preview's "capability gate" step. Sent by the API already.
export type ActionRequirementView =
  | { kind: "none" }
  | { kind: "base"; action: string }
  | { kind: "allowlist" }
  | { kind: "token_transaction"; action: string };

export interface CatalogActionView {
  type: string;
  action: {
    labelKey: string;
    descriptionKey: string;
    execution: ExecutionTier;
    requires: ActionRequirementView;
  };
  support: { ok: true } | { ok: false; reason: string };
}

// GUARD leg: a flat AND of simple field comparisons over the trigger payload. Mirrors
// WorkflowCondition in @sdp/types; the API's createWorkflowSchema already accepts it.
export type GuardOperator = "eq" | "neq" | "in";
export interface GuardClause {
  field: string;
  op: GuardOperator;
  value: string | number | Array<string | number>;
}
export interface GuardCondition {
  all: GuardClause[];
}

// A single editable GUARD row in the builder. `id` is a stable draft identity (React
// key survives row removal without caret/IME jumps); `value` stays a raw string while
// editing; for the `in` operator it's comma-separated and split at submit time.
export interface GuardDraft {
  id: string;
  field: string;
  op: GuardOperator;
  value: string;
}

export interface WorkflowCatalog {
  triggers: CatalogTriggerView[];
  actions: CatalogActionView[];
}

// "kyc_approved" → "KYC approved". Avoids a large i18n block for the dynamic catalog.
export function humanizeType(type: string): string {
  const spaced = type.replace(/_/g, " ");
  const cap = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return cap.replace(/\bkyc\b/gi, "KYC");
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  return body.data as T;
}

const base = (tokenId: string) =>
  `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/workflows`;

export async function fetchWorkflows(tokenId: string): Promise<WorkflowRuleView[]> {
  const data = await readEnvelope<{ workflows: WorkflowRuleView[] }>(
    await fetch(base(tokenId), { cache: "no-store" })
  );
  return data.workflows ?? [];
}

export async function fetchWorkflowCatalog(tokenId: string): Promise<WorkflowCatalog> {
  return readEnvelope<WorkflowCatalog>(
    await fetch(`${base(tokenId)}/catalog`, { cache: "no-store" })
  );
}

export async function fetchExecutions(
  tokenId: string,
  pageSize = 50
): Promise<{ executions: ExecutionView[]; total: number }> {
  const data = await readEnvelope<{ executions: ExecutionView[]; total: number }>(
    await fetch(`${base(tokenId)}/executions?pageSize=${pageSize}`, { cache: "no-store" })
  );
  return { executions: data.executions ?? [], total: data.total ?? 0 };
}

export async function fetchHolders(
  tokenId: string
): Promise<{ holders: HolderView[]; total: number }> {
  const data = await readEnvelope<{ holders: HolderView[]; total: number }>(
    await fetch(`/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/holders`, {
      cache: "no-store",
    })
  );
  return { holders: data.holders ?? [], total: data.total ?? 0 };
}

export interface WorkflowRuleInput {
  triggerType: string;
  actionType: string;
  reviewMode: "auto" | "manual";
  actionParams?: Record<string, string | number>;
  // Optional GUARD ("only if…"). Omit entirely when the user added no rows — the API
  // treats an absent condition as "always match".
  condition?: GuardCondition;
}

export async function createWorkflow(
  tokenId: string,
  input: WorkflowRuleInput
): Promise<WorkflowRuleView> {
  const data = await readEnvelope<{ workflow: WorkflowRuleView }>(
    await fetch(base(tokenId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  );
  return data.workflow;
}

// PATCH an existing rule's editable parts (trigger/action are immutable — build a new
// rule for those). `condition: null` clears the guard.
export async function updateWorkflow(
  tokenId: string,
  workflowId: string,
  input: {
    actionParams?: Record<string, string | number>;
    condition?: GuardCondition | null;
    reviewMode?: "auto" | "manual";
  }
): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/${encodeURIComponent(workflowId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

// Soft delete server-side: the rule disappears; its execution history is retained.
export async function deleteWorkflow(tokenId: string, workflowId: string): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/${encodeURIComponent(workflowId)}`, { method: "DELETE" })
  );
}

// Whether the email channel is available. Exposes only a boolean — no provider details.
// Returns null when the config itself can't be loaded, so a transient failure is NOT
// rendered as "email is deliberately unconfigured".
export async function fetchNotificationConfig(): Promise<{ emailEnabled: boolean } | null> {
  try {
    return await readEnvelope<{ emailEnabled: boolean }>(
      await fetch("/api/dashboard/notifications/config", { cache: "no-store" })
    );
  } catch {
    return null;
  }
}

export async function setWorkflowEnabled(
  tokenId: string,
  workflowId: string,
  enabled: boolean
): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/${encodeURIComponent(workflowId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
  );
}

// Approve a held (awaiting_review) execution → pending. Separate from retry so the
// audit trail can distinguish authorizing an action from re-attempting a failed one.
export async function approveExecution(tokenId: string, executionId: string): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/executions/${encodeURIComponent(executionId)}/approve`, {
      method: "POST",
    })
  );
}

// Re-attempt a failed execution → pending.
export async function retryExecution(tokenId: string, executionId: string): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/executions/${encodeURIComponent(executionId)}/retry`, {
      method: "POST",
    })
  );
}

// Reject a held (awaiting_review) execution → cancelled.
export async function rejectExecution(tokenId: string, executionId: string): Promise<void> {
  await readEnvelope(
    await fetch(`${base(tokenId)}/executions/${encodeURIComponent(executionId)}/reject`, {
      method: "POST",
    })
  );
}

export async function enrollHolder(
  tokenId: string,
  input: { walletAddress: string; counterpartyId?: string | null }
): Promise<void> {
  await readEnvelope(
    await fetch(`/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/holders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}
