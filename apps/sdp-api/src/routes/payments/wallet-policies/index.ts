import { Hono } from "hono";
import { requireAdminApiKeyRole, requirePermissions } from "@/middleware/auth";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  getWalletBalances,
  getWalletPolicy,
  getWalletPolicyEvaluation,
  listWalletControlProfileRevisions,
  listWalletPolicyEvaluations,
  updateWalletPolicy,
} from "./handlers";
import { updateWalletPolicySchema } from "./schemas";

const walletPolicies = new Hono<{ Bindings: Env }>();

walletPolicies.get(
  "/:walletId/balances",
  requirePermissions("wallets:read", "payments:read"),
  getWalletBalances
);
walletPolicies.get(
  "/:walletId/policies",
  requirePermissions("wallets:read", "payments:read"),
  getWalletPolicy
);
walletPolicies.get(
  "/:walletId/policies/revisions",
  requirePermissions("wallets:read", "payments:read"),
  listWalletControlProfileRevisions
);
walletPolicies.get(
  "/:walletId/policies/evaluations",
  requirePermissions("wallets:read", "payments:read"),
  listWalletPolicyEvaluations
);
walletPolicies.get(
  "/:walletId/policies/evaluations/:policyEvaluationId",
  requirePermissions("wallets:read", "payments:read"),
  getWalletPolicyEvaluation
);
walletPolicies.put(
  "/:walletId/policies",
  requirePermissions("wallets:write", "payments:write"),
  requireAdminApiKeyRole(),
  validateBody(updateWalletPolicySchema),
  updateWalletPolicy
);

export default walletPolicies;
