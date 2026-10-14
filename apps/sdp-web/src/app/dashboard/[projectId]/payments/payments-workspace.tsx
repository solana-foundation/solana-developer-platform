"use client";

import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import dynamic from "next/dynamic";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";

const PaymentsPlayground = dynamic(
  () => import("./payments-playground").then((module) => module.PaymentsPlayground),
  {
    loading: () => <ApiPlaygroundShellSkeleton />,
  }
);

interface PaymentsPlaygroundWorkspaceProps {
  apiBaseUrl: string | null;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  transfers: PaymentTransferSummary[];
  transfersError: string | null;
}

export function PaymentsPlaygroundWorkspace({
  apiBaseUrl,
  wallets,
  walletsError,
  transfers,
  transfersError,
}: PaymentsPlaygroundWorkspaceProps) {
  return (
    <PaymentsPlayground
      apiBaseUrl={apiBaseUrl}
      transfers={transfers}
      transfersError={transfersError}
      wallets={wallets}
      walletsError={walletsError}
    />
  );
}
