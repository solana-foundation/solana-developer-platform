import type { WalletApprovalRequestSummary } from "@sdp/types";
import { z } from "zod";
import { type ApprovalRequestDetailRow, createPolicyRepository } from "@/db/repositories";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import {
  AppError,
  badRequestParams,
  badRequestQuery,
  conflict,
  forbidden,
  notFound,
} from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createSigningService } from "@/services/domain/signing.service";
import { executeApprovedWalletOperation } from "@/services/policy/approved-operation-replay";
import { WalletPolicyEnforcementService } from "@/services/policy/enforcement.service";
import type { AppContext } from "../context";
import { approvalRequestListQuerySchema, approvalRequestParamsSchema } from "../schemas";

function mapApprovalRequest(
  row: ApprovalRequestDetailRow,
  viewer: ViewerDecision
): WalletApprovalRequestSummary {
  return {
    id: row.approval_request_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    walletOperationId: row.wallet_operation_id,
    approvalGroupId: row.approval_group_id,
    status: row.approval_status,
    provider: row.provider,
    providerReference: row.provider_reference,
    requestedBy: row.requested_by,
    resolvedBy: row.resolved_by,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    createdAt: row.approval_created_at,
    updatedAt: row.approval_updated_at,
    wallet:
      row.custody_wallet_id && row.wallet_public_key
        ? {
            custodyWalletId: row.custody_wallet_id,
            walletId: row.wallet_id,
            publicKey: row.wallet_public_key,
            label: row.wallet_label,
          }
        : null,
    operation: {
      id: row.wallet_operation_id,
      custodyWalletId: row.custody_wallet_id,
      walletId: row.wallet_id,
      apiKeyId: row.api_key_id,
      source: row.source,
      operationFamily: row.operation_family,
      operationType: row.operation_type,
      asset: row.asset,
      amount: row.amount,
      destination: row.destination,
      status: row.operation_status,
      executionStartedAt: row.operation_execution_started_at,
      executionCompletedAt: row.operation_execution_completed_at,
      executionError: row.operation_execution_error,
      createdAt: row.operation_created_at,
      updatedAt: row.operation_updated_at,
    },
    policyEvaluation: row.policy_evaluation_id
      ? {
          id: row.policy_evaluation_id,
          decision: row.decision ?? "not_evaluated",
          reasonCode: row.reason_code,
          reason: row.reason,
          matchedRules: row.matched_rules,
          requiresApproval: row.requires_approval ?? false,
          evaluatedAt: row.evaluated_at ?? row.approval_created_at,
        }
      : null,
    viewerIsRequester: viewer.isRequester,
    viewerCanDecide: viewer.refusal === null,
  };
}

function parseApprovalRequestParams(c: AppContext) {
  const parsed = approvalRequestParamsSchema.safeParse({
    approvalRequestId: c.req.param("approvalRequestId"),
  });

  if (!parsed.success) {
    throw badRequestParams({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  return parsed.data;
}

function actorId(auth: ApiKeyContext): string {
  return auth.userId ?? auth.apiKeyId ?? auth.id;
}

/**
 * Answers "did the caller raise this request?" for one request or many.
 *
 * A user and every API key they created are the same owner. Comparing only
 * principal ids would let one person request with a session and approve with
 * their API key (or the reverse). The decision routes refuse on this answer, and
 * reads report it, so the dashboard never offers a decision the API will refuse.
 *
 * Every principal on the page is resolved in ONE read: the inbox refreshes on a
 * timer, and a lookup per requester made a full page cost hundreds of queries.
 *
 * @param repository - Policy repository.
 * @param auth - The caller.
 * @param requesters - Every `requested_by` on the page; nulls are ignored.
 * @returns A predicate over `requested_by`.
 */
async function requesterCheck(
  repository: ReturnType<typeof createPolicyRepository>,
  auth: ApiKeyContext,
  requesters: readonly (string | null)[]
): Promise<(requestedBy: string | null) => boolean> {
  const caller = actorId(auth);
  const principals = [...new Set([caller, ...requesters.filter((id) => id !== null)])];
  const creators = await repository.getApiKeyCreatorUserIds(principals);
  // A principal that names no api key is already a user id, and owns itself.
  const ownerOf = (principalId: string) => creators.get(principalId) ?? principalId;
  const callerOwner = ownerOf(caller);
  return (requestedBy) => requestedBy !== null && ownerOf(requestedBy) === callerOwner;
}

type DecisionRefusal = "requester" | "not_group_member" | "not_admin";

/** The fields of a request that decide who may approve or reject it. */
type DecisionRow = Pick<ApprovalRequestDetailRow, "requested_by" | "approval_group_id">;

interface ViewerDecision {
  isRequester: boolean;
  /** Why the caller cannot approve or reject, or null when they can. */
  refusal: DecisionRefusal | null;
}

/**
 * Answers "may the caller approve or reject this request?" for one request or
 * many. The decision routes refuse on this answer and reads report it, so the
 * dashboard offers exactly the decisions the API accepts.
 *
 * - Whoever raised the request never decides it.
 * - A request routed to an approval group is decided by that group's active
 *   approvers, who must be signed-in users.
 * - Any other request is decided by an organization admin.
 *
 * Group membership is read once per distinct group on the page, not per row.
 *
 * @param repository - Policy repository.
 * @param auth - The caller.
 * @param rows - Every request on the page.
 * @returns The caller's standing on a row.
 */
async function viewerDecisionCheck(
  repository: ReturnType<typeof createPolicyRepository>,
  auth: ApiKeyContext,
  rows: readonly DecisionRow[]
): Promise<(row: DecisionRow) => ViewerDecision> {
  const isRequester = await requesterCheck(
    repository,
    auth,
    rows.map((row) => row.requested_by)
  );
  const userId = auth.userId;
  const groupIds = [
    ...new Set(rows.flatMap((row) => (row.approval_group_id ? [row.approval_group_id] : []))),
  ];
  const approverGroups = new Set<string>();
  if (userId) {
    const memberships = await Promise.all(
      groupIds.map((groupId) => repository.isApprovalGroupMember(groupId, userId))
    );
    groupIds.forEach((groupId, index) => {
      if (memberships[index]) approverGroups.add(groupId);
    });
  }
  const isAdmin = auth.permissions.includes("org:admin") || auth.permissions.includes("*");

  return (row) => {
    if (isRequester(row.requested_by)) {
      return { isRequester: true, refusal: "requester" };
    }
    if (row.approval_group_id) {
      return {
        isRequester: false,
        refusal: approverGroups.has(row.approval_group_id) ? null : "not_group_member",
      };
    }
    return { isRequester: false, refusal: isAdmin ? null : "not_admin" };
  };
}

async function readApprovalRequest(c: AppContext, approvalRequestId: string) {
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  const row = await repository.getApprovalRequestDetail({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    approvalRequestId,
  });

  if (!row) {
    throw notFound("Approval request");
  }

  const viewer = await viewerDecisionCheck(repository, auth, [row]);
  return mapApprovalRequest(row, viewer(row));
}

const DECISION_REFUSAL_MESSAGE: Record<DecisionRefusal, string> = {
  requester: "Approval requests must be decided by a different principal",
  not_group_member: "Approval request must be decided by an active approval-group member",
  not_admin: "Ungrouped approval requests must be decided by an organization admin",
};

async function assertCanResolveApprovalRequest(
  c: AppContext,
  repository: ReturnType<typeof createPolicyRepository>,
  approvalRequestId: string,
  action: "approve" | "reject" | "cancel"
) {
  const auth = getAuth(c);
  const row = await repository.getApprovalRequestDetail({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    approvalRequestId,
  });
  if (!row) {
    throw notFound("Approval request");
  }

  const { isRequester, refusal } = (await viewerDecisionCheck(repository, auth, [row]))(row);
  // Requesters may withdraw their own pending request, but they cannot satisfy
  // or reject the approval gate they created.
  if (isRequester && action === "cancel") {
    return row;
  }
  if (refusal !== null) {
    throw forbidden(DECISION_REFUSAL_MESSAGE[refusal]);
  }
  return row;
}

export const listApprovalRequests = async (c: AppContext) => {
  const auth = getAuth(c);
  const parsed = approvalRequestListQuerySchema.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  const rows = await repository.listApprovalRequestDetails({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    status: parsed.data.status,
    limit: parsed.data.limit,
  });

  const viewer = await viewerDecisionCheck(repository, auth, rows);
  return success(c, {
    approvalRequests: rows.map((row) => mapApprovalRequest(row, viewer(row))),
  });
};

export const getApprovalRequest = async (c: AppContext) => {
  const { approvalRequestId } = parseApprovalRequestParams(c);
  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};

export const approveApprovalRequest = async (c: AppContext) => {
  const { approvalRequestId } = parseApprovalRequestParams(c);
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  const current = await assertCanResolveApprovalRequest(
    c,
    repository,
    approvalRequestId,
    "approve"
  );
  // A new approval admits its pinned wallet before the decision, like every
  // other new execution attempt. Existing approvals keep their replay contract.
  if (current.approval_status === "pending") {
    try {
      if (current.custody_wallet_id) {
        await createSigningService(c.env, getRequestTenantScope(c)).admitRuntimeExecution(
          current.organization_id,
          current.project_id ?? undefined,
          current.custody_wallet_id
        );
      } else if (
        current.operation_family !== "program" ||
        current.operation_type !== "earn_program_withdrawal"
      ) {
        // Provider-managed program withdrawals have no SDP custody signer.
        // A missing pin is not an execution bypass for any other operation.
        throw conflict("Wallet operation has no custody wallet", {
          reason: "runtime_execution_unavailable",
        });
      }
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        (error.code !== "NOT_FOUND" &&
          error.details?.reason !== "runtime_execution_paused" &&
          error.details?.reason !== "runtime_execution_unavailable" &&
          error.details?.reason !== "provider_not_entitled")
      ) {
        throw error;
      }
      // Another resolver may have decided while admission was in flight.
      // Let the existing decision path handle terminal replay or conflict.
      const latest = await repository.getApprovalRequestDetail({
        organizationId: auth.organizationId,
        projectId: auth.projectId,
        approvalRequestId,
      });
      if (!latest || latest.approval_status === "pending") {
        throw error;
      }
    }
  }
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository,
    getRequestTenantScope(c)
  ).approveApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth), auth.projectId);

  if (!approvalRequest) {
    throw notFound("Approval request");
  }

  const operation = await repository.getWalletOperationById(current.wallet_operation_id);
  if (!operation) {
    throw notFound("Wallet operation");
  }
  await executeApprovedWalletOperation(c.env, repository, operation);

  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};

export const rejectApprovalRequest = async (c: AppContext) => {
  const { approvalRequestId } = parseApprovalRequestParams(c);
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  await assertCanResolveApprovalRequest(c, repository, approvalRequestId, "reject");
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository,
    getRequestTenantScope(c)
  ).rejectApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth), auth.projectId);

  if (!approvalRequest) {
    throw notFound("Approval request");
  }

  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};

export const cancelApprovalRequest = async (c: AppContext) => {
  const { approvalRequestId } = parseApprovalRequestParams(c);
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env, getRequestTenantScope(c));
  await assertCanResolveApprovalRequest(c, repository, approvalRequestId, "cancel");
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository,
    getRequestTenantScope(c)
  ).cancelApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth), auth.projectId);

  if (!approvalRequest) {
    throw notFound("Approval request");
  }

  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};
