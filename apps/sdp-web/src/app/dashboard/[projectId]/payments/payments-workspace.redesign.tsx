"use client";

import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import dynamic from "next/dynamic";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import type { CounterpartyPlaygroundView } from "./counterparty/counterparty-playground-config.redesign";

const PaymentsPlayground = dynamic(
  () => import("./payments-playground.redesign").then((module) => module.PaymentsPlayground),
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
  counterparties: CounterpartyPlaygroundView[];
  rampProviders: readonly RampProviderId[];
}

export function PaymentsPlaygroundWorkspace({
  apiBaseUrl,
  wallets,
  walletsError,
  transfers,
  transfersError,
  counterparties,
  rampProviders,
}: PaymentsPlaygroundWorkspaceProps) {
  return (
    <PaymentsPlayground
      apiBaseUrl={apiBaseUrl}
      transfers={transfers}
      transfersError={transfersError}
      wallets={wallets}
      walletsError={walletsError}
      counterparties={counterparties}
      rampProviders={rampProviders}
    />
  );
}
