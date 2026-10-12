import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { AppError } from "@/lib/errors";
import type { AppContext } from "../context";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  resolveScope,
  resolveWallet,
  resolveWalletByCustodyWalletId,
} from "../wallets";

export async function resolveSubscriptionPlanWalletSelector(
  c: AppContext,
  selector: { custodyWalletId?: string; walletId?: string }
) {
  const scope = await resolveScope(c);
  const wallet =
    selector.custodyWalletId !== undefined
      ? resolveWalletByCustodyWalletId(scope.wallets, selector.custodyWalletId)
      : resolveWallet(scope.wallets, selector.walletId ?? "");
  assertPaymentWalletExactAccess(c, wallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);
  return wallet;
}

export function hasSubscriptionPlanPuller(plan: PaymentSubscriptionPlanRow): boolean {
  return (
    plan.puller_custody_wallet_id !== null ||
    plan.puller_wallet_id !== null ||
    plan.puller_address !== null
  );
}

export async function resolveSubscriptionPlanRole(
  c: AppContext,
  plan: PaymentSubscriptionPlanRow,
  role: "owner" | "puller"
) {
  const custodyWalletId =
    role === "owner" ? plan.owner_custody_wallet_id : plan.puller_custody_wallet_id;
  const savedAddress = role === "owner" ? plan.owner_address : plan.puller_address;
  if (!custodyWalletId || plan.role_projection_revision < 1) {
    throw new AppError("CONFLICT", `Subscription plan ${role} wallet identity is unresolved`);
  }
  const wallet = await resolveSubscriptionPlanWalletSelector(c, { custodyWalletId });
  if (wallet.publicKey !== savedAddress) {
    throw new AppError(
      "BAD_REQUEST",
      `Subscription plan ${role} wallet does not match saved address`
    );
  }
  return wallet;
}
