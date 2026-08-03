import type {
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  PolicyDefaultAction,
  PolicyRule,
  WalletOperationEnvelope,
} from "@sdp/types";

export const operation: WalletOperationEnvelope = {
  id: "wop_1",
  organizationId: "org_1",
  projectId: "prj_1",
  custodyWalletId: "cw_1",
  walletId: "wal_1",
  apiKeyId: "key_1",
  actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
  source: "api",
  operationFamily: "payment",
  operationType: "payment_request",
  asset: "USDC",
  amount: "125.50",
  destination: "recipient_blocked",
  context: { requestId: "req_1" },
  providerExtensions: { provider: "future-provider" },
  rawPayload: { paymentRequestId: "payreq_1" },
  idempotencyKey: "idem_1",
  status: "created",
  createdAt: "2026-06-18T00:00:00.000Z",
  updatedAt: "2026-06-18T00:00:00.000Z",
};

/**
 * Build an active wallet policy holding the given rules.
 *
 * @param rules - The revision's rules.
 * @param defaultAction - The revision's default action.
 * @returns The effective wallet policy.
 */
export function walletPolicy(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): EffectiveWalletPolicy {
  return {
    source: "customer_profile",
    profile: {
      id: "wcp_1",
      organizationId: "org_1",
      projectId: "prj_1",
      custodyWalletId: "cw_1",
      name: "Wallet controls",
      status: "active",
      activeRevisionId: "wcpr_1",
      createdBy: "usr_1",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      activatedAt: "2026-06-18T00:00:00.000Z",
      archivedAt: null,
    },
    revision: {
      id: "wcpr_1",
      profileId: "wcp_1",
      revisionNumber: 1,
      rules,
      defaultAction,
      createdBy: "usr_1",
      createdAt: "2026-06-18T00:00:00.000Z",
      activatedAt: "2026-06-18T00:00:00.000Z",
    },
    defaultAction,
  };
}

/**
 * Build an active API-key policy holding the given rules.
 *
 * @param rules - The revision's rules.
 * @param defaultAction - The revision's default action.
 * @returns The effective API-key policy.
 */
export function apiKeyPolicy(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): EffectiveApiKeyPolicy {
  return {
    source: "customer_profile",
    profile: {
      id: "akcp_1",
      organizationId: "org_1",
      projectId: "prj_1",
      apiKeyId: "key_1",
      name: "API key controls",
      status: "active",
      activeRevisionId: "akcpr_1",
      createdBy: "usr_1",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
      activatedAt: "2026-06-18T00:00:00.000Z",
      archivedAt: null,
    },
    revision: {
      id: "akcpr_1",
      profileId: "akcp_1",
      revisionNumber: 1,
      rules,
      defaultAction,
      createdBy: "usr_1",
      createdAt: "2026-06-18T00:00:00.000Z",
      activatedAt: "2026-06-18T00:00:00.000Z",
    },
    defaultAction,
  };
}
