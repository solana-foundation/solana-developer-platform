import type { WalletApprovalRequestSummary } from "@sdp/types";
import { z } from "zod";
import { type ApprovalRequestDetailRow, createPolicyRepository } from "@/db/repositories";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import { badRequestParams, badRequestQuery, forbidden, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { executeApprovedWalletOperation } from "@/services/policy/approved-operation-replay";
import { WalletPolicyEnforcementService } from "@/services/policy/enforcement.service";
import type { AppContext } from "../context";
import { approvalRequestListQuerySchema, approvalRequestParamsSchema } from "../schemas";

function mapApprovalRequest(row: ApprovalRequestDetailRow): WalletApprovalRequestSummary {
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

async function actorOwnerId(
  repository: ReturnType<typeof createPolicyRepository>,
  principalId: string
): Promise<string> {
  return (await repository.getApiKeyCreatorUserId(principalId)) ?? principalId;
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

  return mapApprovalRequest(row);
}

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

  // Treat a user and every API key they created as the same owner. Comparing
  // only principal IDs would let one person request with a session and approve
  // with their API key (or the reverse).
  const resolverOwnerId = await actorOwnerId(repository, actorId(auth));
  const requesterOwnerId = row.requested_by
    ? await actorOwnerId(repository, row.requested_by)
    : null;

  // Requesters may withdraw their own pending request, but they cannot satisfy
  // or reject the approval gate they created.
  if (requesterOwnerId && requesterOwnerId === resolverOwnerId) {
    if (action === "cancel") {
      return row;
    }
    throw forbidden("Approval requests must be decided by a different principal");
  }

  if (row.approval_group_id) {
    if (
      !auth.userId ||
      !(await repository.isApprovalGroupMember(row.approval_group_id, auth.userId))
    ) {
      throw forbidden("Approval request must be decided by an active approval-group member");
    }
    return row;
  }

  if (!auth.permissions.includes("org:admin") && !auth.permissions.includes("*")) {
    throw forbidden("Ungrouped approval requests must be decided by an organization admin");
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

  const rows = await createPolicyRepository(
    c.env,
    getRequestTenantScope(c)
  ).listApprovalRequestDetails({
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    status: parsed.data.status,
    limit: parsed.data.limit,
  });

  return success(c, {
    approvalRequests: rows.map(mapApprovalRequest),
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
