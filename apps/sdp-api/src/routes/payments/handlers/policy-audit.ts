import { redactCredentialSecrets } from "@sdp/custody";
import type {
  PolicyEvaluationContext,
  PolicyRule,
  PublicPolicyEvaluationContext,
  WalletControlProfileRevisionHistory,
  WalletPolicyEvaluationDetail,
} from "@sdp/types";
import { z } from "zod";
import {
  createPolicyRepository,
  type WalletControlProfileRevisionHistoryRow,
  type WalletPolicyEvaluationAuditRow,
} from "@/db/repositories";
import { badRequestParams, badRequestQuery, notFound } from "@/lib/errors";
import { paginated, success } from "@/lib/response";
import type { AppContext } from "../context";
import {
  walletPolicyEvaluationListQuerySchema,
  walletPolicyEvaluationParamsSchema,
} from "../schemas";
import { resolveWalletFromParams } from "./transfers";

function mapRevisionHistory(
  history: WalletControlProfileRevisionHistoryRow | null
): WalletControlProfileRevisionHistory {
  if (!history) {
    return { profile: null, revisions: [] };
  }

  const { profile } = history;
  return {
    profile: {
      id: profile.id,
      organizationId: profile.organization_id,
      projectId: profile.project_id,
      custodyWalletId: profile.custody_wallet_id,
      name: profile.name,
      status: profile.status,
      activeRevisionId: profile.active_revision_id,
      createdBy: profile.created_by,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      activatedAt: profile.activated_at,
      archivedAt: profile.archived_at,
    },
    revisions: history.revisions.map((revision) => ({
      id: revision.id,
      profileId: revision.profile_id,
      revisionNumber: revision.revision_number,
      rules: redactCredentialSecrets(revision.rules as unknown as PolicyRule[]),
      defaultAction: revision.default_action,
      createdBy: revision.created_by,
      createdAt: revision.created_at,
      activatedAt: revision.activated_at,
      isActive: revision.id === profile.active_revision_id,
    })),
  };
}

function publicEvaluationContext(
  context: PolicyEvaluationContext | null
): PublicPolicyEvaluationContext | null {
  if (!context) {
    return null;
  }

  const operation: Record<string, unknown> = { ...context.operation };
  delete operation.rawPayload;
  delete operation.providerExtensions;

  return redactCredentialSecrets({
    ...context,
    operation,
  }) as PublicPolicyEvaluationContext;
}

function mapPolicyEvaluation(row: WalletPolicyEvaluationAuditRow): WalletPolicyEvaluationDetail {
  return {
    id: row.policy_evaluation_id,
    walletOperation: {
      id: row.wallet_operation_id,
      operationFamily: row.operation_family,
      operationType: row.operation_type,
      asset: row.asset,
      amount: row.amount,
      destination: row.destination,
      status: row.operation_status,
      createdAt: row.operation_created_at,
      updatedAt: row.operation_updated_at,
    },
    policyRevisions: {
      wallet: {
        evaluatedRevisionId: row.wallet_policy_revision_id,
        activeRevisionId: row.active_wallet_policy_revision_id,
      },
      apiKey: {
        evaluatedRevisionId: row.api_key_policy_revision_id,
        activeRevisionId: row.active_api_key_policy_revision_id,
      },
    },
    decision: row.decision,
    reasonCode: row.reason_code,
    reason: row.reason,
    matchedRules: redactCredentialSecrets(row.matched_rules),
    evaluationContext: publicEvaluationContext(row.evaluation_context),
    requiresApproval: row.requires_approval,
    approvalRequestId: row.approval_request_id,
    evaluatedAt: row.evaluated_at,
  };
}

export async function listWalletControlProfileRevisions(c: AppContext) {
  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const history = await createPolicyRepository(c.env).getWalletControlProfileRevisionHistory({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
  });

  return success(c, mapRevisionHistory(history));
}

export async function listWalletPolicyEvaluations(c: AppContext) {
  const parsed = walletPolicyEvaluationListQuerySchema.safeParse({
    page: c.req.query("page"),
    pageSize: c.req.query("pageSize"),
    decision: c.req.query("decision"),
    status: c.req.query("status"),
    operationFamily: c.req.query("operationFamily"),
    reasonCode: c.req.query("reasonCode"),
  });
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const result = await createPolicyRepository(c.env).listWalletPolicyEvaluationAudits({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
    ...parsed.data,
  });

  return paginated(c, result.rows.map(mapPolicyEvaluation), {
    total: result.total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
}

export async function getWalletPolicyEvaluation(c: AppContext) {
  const parsed = walletPolicyEvaluationParamsSchema.safeParse(c.req.param());
  if (!parsed.success) {
    throw badRequestParams({ errors: z.flattenError(parsed.error).fieldErrors });
  }

  const { auth, wallet } = await resolveWalletFromParams(c, ["wallets:read"]);
  const evaluation = await createPolicyRepository(c.env).getWalletPolicyEvaluationAudit({
    organizationId: auth.organizationId,
    projectId: auth.projectId ?? null,
    custodyWalletId: wallet.id,
    policyEvaluationId: parsed.data.policyEvaluationId,
  });
  if (!evaluation) {
    throw notFound("Policy evaluation");
  }

  return success(c, { policyEvaluation: mapPolicyEvaluation(evaluation) });
}
