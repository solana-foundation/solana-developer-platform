export const APPROVAL_ACTIONS = ["approve", "reject", "cancel"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalActionOutcome =
  | "success"
  | "stale"
  | "forbidden"
  | "failure"
  | "runtime_paused"
  | "runtime_unavailable"
  | "provider_not_entitled";

export function isApprovalAction(action: string): action is ApprovalAction {
  return APPROVAL_ACTIONS.includes(action as ApprovalAction);
}

export function buildApprovalActionPath(approvalRequestId: string, action: ApprovalAction): string {
  return `/api/dashboard/approval-requests/${encodeURIComponent(approvalRequestId)}/${action}`;
}

export function classifyApprovalActionResponse(
  status: number,
  reason?: string
): ApprovalActionOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 403 && reason === "provider_not_entitled") return "provider_not_entitled";
  if (status === 403 && reason === "runtime_execution_paused") return "runtime_paused";
  if (status === 409 && reason === "runtime_execution_unavailable") return "runtime_unavailable";
  if (status === 409) return "stale";
  if (status === 403) return "forbidden";
  return "failure";
}
