import type {
  Permission,
  PolicyControlInventoryItem,
  PolicyControlInventoryResponse,
  PolicyControlInventoryTarget,
} from "@sdp/types";
import type { Context } from "hono";
import { z } from "zod";
import { createPolicyRepository, type PolicyControlInventoryRow } from "@/db/repositories";
import { getAuth } from "@/lib/auth";
import { AppError, badRequestQuery } from "@/lib/errors";
import { success } from "@/lib/response";
import { getAllowedApiKeyWalletIdsForPermissions } from "@/services/api-key-scope.service";
import type { Env } from "@/types/env";
import { policyControlInventoryQuerySchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

function assertTargetPermissions(
  permissions: Permission[],
  target: PolicyControlInventoryTarget
): void {
  const required: Permission[] = [];
  if (target === "wallet" || target === "all") {
    required.push("wallets:read");
  }
  if (target === "api_key" || target === "all") {
    required.push("api-keys:read");
  }

  if (
    !permissions.includes("*") &&
    !required.every((permission) => permissions.includes(permission))
  ) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", `Required permissions: ${required.join(", ")}`);
  }
}

function mapLatestEvaluation(row: PolicyControlInventoryRow) {
  if (!row.latest_evaluation_decision || !row.latest_evaluation_at) {
    return null;
  }

  return {
    decision: row.latest_evaluation_decision,
    evaluatedAt: row.latest_evaluation_at,
  };
}

function mapInventoryItem(row: PolicyControlInventoryRow): PolicyControlInventoryItem {
  const base = {
    targetId: row.target_id,
    displayName: row.display_name,
    controlProfileId: row.control_profile_id,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    activeRevisionNumber: row.active_revision_number,
    defaultAction: row.default_action,
    ruleCount: row.rule_count,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    latestEvaluation: mapLatestEvaluation(row),
  };

  if (row.target_type === "wallet") {
    return {
      ...base,
      targetType: "wallet",
      walletId: row.wallet_id ?? row.target_id,
      walletAddress: row.wallet_address ?? "",
      providerMappingStatus: row.provider_mapping_status ?? "not_applicable",
    };
  }

  return {
    ...base,
    targetType: "api_key",
    apiKeyPrefix: row.api_key_prefix ?? "",
    bindingScope: row.binding_scope ?? "all",
    selectedWalletCount: row.selected_wallet_count ?? 0,
  };
}

export const listPolicyControlInventory = async (c: AppContext) => {
  const auth = getAuth(c);
  const parsed = policyControlInventoryQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  assertTargetPermissions(auth.permissions, parsed.data.target);
  const allowedWalletIds = getAllowedApiKeyWalletIdsForPermissions(auth, ["wallets:read"]);
  const result = await createPolicyRepository(c.env).listPolicyControlInventory({
    organizationId: auth.organizationId,
    projectId: c.get("projectId") ?? null,
    walletIds: allowedWalletIds ?? undefined,
    ...parsed.data,
  });

  const response: PolicyControlInventoryResponse = {
    controls: result.rows.map(mapInventoryItem),
    total: result.total,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    summary: {
      total: result.summary.total,
      defaultAllow: result.summary.default_allow,
      draft: result.summary.draft,
      active: result.summary.active,
      disabled: result.summary.disabled,
      totalApiKeyBindings: result.summary.total_api_key_bindings,
    },
  };

  return success(c, response);
};
