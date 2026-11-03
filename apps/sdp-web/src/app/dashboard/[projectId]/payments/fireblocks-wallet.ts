import type { PaymentsDashboardWallet } from "@sdp/types/payments";

/** Native transfers and their advisory checks apply only to customer-connected vaults. */
export function isFireblocksByokWallet(wallet: PaymentsDashboardWallet | null): boolean {
  return wallet?.provider === "fireblocks" && Boolean(wallet.custodyConnectionId);
}
