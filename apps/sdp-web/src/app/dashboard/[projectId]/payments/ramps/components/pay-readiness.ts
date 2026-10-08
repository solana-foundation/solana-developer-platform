import type { PaymentsDashboardWallet } from "@sdp/types";

/** Which of a payment's two prerequisites the project is missing. */
export type PayEmptyReason = "no_contact" | "no_funds" | "neither";

/**
 * Why Pay has nothing to do yet, or null when it has a contact to pay and a wallet to pay from.
 *
 * @param hasContact - Whether the project has any contact.
 * @param hasFundedWallet - Whether any wallet holds a balance.
 * @returns The missing prerequisite(s), or null.
 */
export function payEmptyReason(
  hasContact: boolean,
  hasFundedWallet: boolean
): PayEmptyReason | null {
  if (hasContact && hasFundedWallet) return null;
  if (!hasContact && !hasFundedWallet) return "neither";
  return hasContact ? "no_funds" : "no_contact";
}

/** Whether any wallet holds any token at all. */
export function hasFundedWallet(wallets: readonly PaymentsDashboardWallet[]): boolean {
  return wallets.some((wallet) =>
    (wallet.balances ?? []).some((balance) => Number(balance.uiAmount) > 0)
  );
}
