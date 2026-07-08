import type { WalletApprovalRequestSummary } from "@sdp/types";
import { z } from "zod";
import { type ApprovalRequestDetailRow, createPolicyRepository } from "@/db/repositories";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { WalletPolicyEnforcementService } from "@/services/policy-enforcement.service";
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
      createdAt: row.operation_created_at,
      updatedAt: row.operation_updated_at,
    },
    policyEvaluation: row.policy_evaluation_id
      ? {
          id: row.policy_evaluation_id,
          decision: row.decision ?? "not_evaluated",
          reasonCode: row.reason_code ?? "not_evaluated",
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

async function readApprovalRequest(c: AppContext, approvalRequestId: string) {
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env);
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

export const listApprovalRequests = async (c: AppContext) => {
  const auth = getAuth(c);
  const parsed = approvalRequestListQuerySchema.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const rows = await createPolicyRepository(c.env).listApprovalRequestDetails({
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
  const repository = createPolicyRepository(c.env);
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository
  ).approveApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth));

  if (!approvalRequest) {
    throw notFound("Approval request");
  }

  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};

export const rejectApprovalRequest = async (c: AppContext) => {
  const { approvalRequestId } = parseApprovalRequestParams(c);
  const auth = getAuth(c);
  const repository = createPolicyRepository(c.env);
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository
  ).rejectApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth));

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
  const repository = createPolicyRepository(c.env);
  const approvalRequest = await new WalletPolicyEnforcementService(
    repository
  ).cancelApprovalRequest(auth.organizationId, approvalRequestId, actorId(auth));

  if (!approvalRequest) {
    throw notFound("Approval request");
  }

  return success(c, {
    approvalRequest: await readApprovalRequest(c, approvalRequestId),
  });
};
