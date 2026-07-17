export const APPROVAL_ACTIONS = ["approve", "reject", "cancel"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export type ApprovalActionOutcome = "success" | "stale" | "forbidden" | "failure";

export function isApprovalAction(action: string): action is ApprovalAction {
  return APPROVAL_ACTIONS.includes(action as ApprovalAction);
}

export function buildApprovalActionPath(approvalRequestId: string, action: ApprovalAction): string {
  return `/api/dashboard/approval-requests/${encodeURIComponent(approvalRequestId)}/${action}`;
}

export function classifyApprovalActionResponse(status: number): ApprovalActionOutcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 409) return "stale";
  if (status === 403) return "forbidden";
  return "failure";
}
