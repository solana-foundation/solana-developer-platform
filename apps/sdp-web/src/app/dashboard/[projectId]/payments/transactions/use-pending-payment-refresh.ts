"use client";

import { isRampTransferType, type PaymentTransferType } from "@sdp/types/payments";
import type { UnifiedTransaction } from "@sdp/types/unified-transactions";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refresh pending payments; ramps already poll through useLiveRampTransfer. */
export function usePendingPaymentRefresh(
  transaction: Pick<UnifiedTransaction, "module" | "status">,
  transferType: PaymentTransferType | undefined
): void {
  const router = useRouter();
  const hasRampPoller = transferType !== undefined && isRampTransferType(transferType);
  const waitingForPayment =
    transaction.module === "payments" && transaction.status === "pending" && !hasRampPoller;

  useEffect(() => {
    if (!waitingForPayment) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [waitingForPayment, router]);
}
