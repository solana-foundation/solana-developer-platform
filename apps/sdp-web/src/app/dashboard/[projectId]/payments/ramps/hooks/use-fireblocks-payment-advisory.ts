"use client";
import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { isFireblocksByokWallet } from "@/app/dashboard/[projectId]/payments/fireblocks-wallet";
import { useFireblocksDestination } from "./use-fireblocks-destination";
/** Translate the Pay wizard's nullable selections into a single advisory request. */
export function useFireblocksPaymentAdvisory(input: {
  wallet: PaymentsDashboardWallet | null;
  signingUnavailable: boolean;
  submitting: boolean;
  finished: boolean;
  walletId: string;
  counterpartyId: string;
  account: { id: string } | null;
  balance: { mint: string } | null;
  address: string | null;
}) {
  useFireblocksDestination({
    enabled:
      isFireblocksByokWallet(input.wallet) &&
      !input.signingUnavailable &&
      !input.submitting &&
      !input.finished,
    walletId: input.walletId,
    counterpartyId: input.counterpartyId,
    accountId: input.account?.id ?? "",
    token: input.balance?.mint ?? null,
    address: input.address,
  });
}
