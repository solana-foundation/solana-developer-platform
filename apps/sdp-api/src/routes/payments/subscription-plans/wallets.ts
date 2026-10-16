import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { AppError } from "@/lib/errors";
import type { AppContext } from "../context";
import { resolveScope, resolveWalletByCustodyWalletId } from "../wallets";

export async function resolveSubscriptionPlanWalletSelector(
  c: AppContext,
  custodyWalletId: string
) {
  const scope = await resolveScope(c);
  return resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
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
  if (!custodyWalletId) {
    throw new AppError("CONFLICT", `Subscription plan ${role} wallet identity is unresolved`);
  }
  const wallet = await resolveSubscriptionPlanWalletSelector(c, custodyWalletId);
  if (wallet.publicKey !== savedAddress) {
    throw new AppError(
      "BAD_REQUEST",
      `Subscription plan ${role} wallet does not match saved address`
    );
  }
  return wallet;
}
