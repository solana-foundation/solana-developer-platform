import type {
  ApprovalRequestStatus,
  WalletApprovalRequestSummary,
  WalletOperationStatus,
} from "@sdp/types";
import { z } from "zod";

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

const APPROVAL_REQUEST_STATUS = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  canceled: "canceled",
  expired: "expired",
  failed: "failed",
} as const satisfies { [Status in ApprovalRequestStatus]: Status };

const WALLET_OPERATION_STATUS = {
  created: "created",
  evaluated: "evaluated",
  pending_approval: "pending_approval",
  executing: "executing",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
} as const satisfies { [Status in WalletOperationStatus]: Status };

/**
 * The fields the detail page branches on: who may decide, and what execution
 * did. Everything else on the summary is display-only and passes through.
 */
const approvalRequestEnvelopeSchema = z.object({
  data: z.object({
    approvalRequest: z.looseObject({
      id: z.string().min(1),
      status: z.enum(APPROVAL_REQUEST_STATUS),
      viewerIsRequester: z.boolean(),
      operation: z.looseObject({
        status: z.enum(WALLET_OPERATION_STATUS),
        executionCompletedAt: z.string().nullable(),
        executionError: z.string().nullable(),
      }),
    }),
  }),
});

const errorEnvelopeSchema = z.object({
  error: z.union([
    z
      .string()
      .min(1)
      .transform((message) => ({ message, details: undefined })),
    z.object({
      message: z.string().min(1).optional(),
      details: z.looseObject({ reason: z.string().optional() }).optional(),
    }),
  ]),
});

export type ApprovalActionResponse =
  | { ok: true; approvalRequest: WalletApprovalRequestSummary | null }
  | { ok: false; status: number; message: string | null; reason: string | undefined };

/**
 * Reads an approval request response from the dashboard proxy. A 2xx whose
 * body does not carry a request yields `approvalRequest: null`, so the caller
 * refetches instead of trusting a partial body. An error keeps the API's own
 * message and reason, which name the rule or runtime state that refused it.
 */
export async function readApprovalActionResponse(
  response: Response
): Promise<ApprovalActionResponse> {
  if (response.ok) {
    const parsed = approvalRequestEnvelopeSchema.safeParse(await response.json().catch(() => null));
    return {
      ok: true,
      approvalRequest: parsed.success
        ? // SAFETY: the proxy forwards the API's WalletApprovalRequestSummary
          // unchanged; the schema checks every field this page branches on.
          (parsed.data.data.approvalRequest as unknown as WalletApprovalRequestSummary)
        : null,
    };
  }
  const error = errorEnvelopeSchema.safeParse(await response.json().catch(() => null));
  return {
    ok: false,
    status: response.status,
    message: error.success ? (error.data.error.message ?? null) : null,
    reason: error.success ? error.data.error.details?.reason : undefined,
  };
}
