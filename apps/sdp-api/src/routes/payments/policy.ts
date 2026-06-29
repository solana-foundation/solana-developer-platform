import {
  assertWalletPolicyAllowsTransferWithRepository,
  buildWalletPolicyPayload,
  DESTINATION_ALLOWLIST_POLICY_TYPE,
  PAYMENT_POLICY_VERSION,
  TRANSFER_LIMITS_POLICY_TYPE,
} from "@/services/payments/wallet-policy";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { type AppContext, getPaymentsRepository } from "./context";

export {
  assertWalletPolicyAllowsTransferWithRepository,
  buildWalletPolicyPayload,
  DESTINATION_ALLOWLIST_POLICY_TYPE,
  PAYMENT_POLICY_VERSION,
  TRANSFER_LIMITS_POLICY_TYPE,
};

export async function assertWalletPolicyAllowsTransfer(
  c: AppContext,
  input: {
    organizationId: string;
    projectId: string | null;
    wallet: CustodyWallet;
    destinationAddress?: string | null;
    enforceDestinationAllowlist?: boolean;
    enforceDailyLimit?: boolean;
    token: string;
    amount: string;
  }
): Promise<void> {
  return assertWalletPolicyAllowsTransferWithRepository(getPaymentsRepository(c), input);
}
