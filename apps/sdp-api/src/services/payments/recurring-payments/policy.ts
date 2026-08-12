import type { WalletOperationPolicyEnforcement } from "@sdp/policy";
import type { WalletOperationActor } from "@sdp/types";
import { createTenantScope } from "@/lib/tenant-scope";
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

export type RecurringPaymentOperationType =
  | "recurring_payment_create"
  | "recurring_payment_update"
  | "recurring_payment_collection";

/**
 * Enforce wallet-operation policy on a recurring-payment operation. Create
 * and update gate the configured transfer shape; collection gates the actual
 * funds movement each cycle. Non-allow decisions throw the route-contract
 * error (403 deny / 202 approval-pending), which a collection run records as
 * the attempt's failure.
 *
 * @param input - The operation's tenant, wallet, transfer shape, and initiator.
 * @returns The recorded operation and its evaluation when allowed.
 */
export async function enforceRecurringPaymentPolicy(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  sourceWallet: CustodyWallet;
  operationType: RecurringPaymentOperationType;
  token: string;
  amount: string;
  destination: string;
  apiKeyId: string | null;
  actor: WalletOperationActor | null;
  rawPayload: Record<string, unknown>;
}): Promise<WalletOperationPolicyEnforcement> {
  const scope = createTenantScope({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });

  return enforceWalletOperationPolicy(input.env, scope, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.sourceWallet.id,
    walletId: input.sourceWallet.walletId,
    apiKeyId: input.apiKeyId,
    actor: input.actor,
    source: input.apiKeyId === null && input.actor === null ? "system" : "api",
    operationFamily: "payment",
    operationType: input.operationType,
    asset: input.token,
    amount: input.amount,
    destination: input.destination,
    legs: [],
    context: {
      sourceAddress: input.sourceWallet.publicKey,
    },
    providerExtensions: {},
    rawPayload: input.rawPayload,
  });
}
