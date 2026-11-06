"use client";

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  buildCounterpartyPlaygroundEndpointConfigs,
  type CounterpartyPlaygroundView,
} from "./counterparty/counterparty-playground-config";
import {
  buildPaymentsPlaygroundEndpointConfigs,
  mergePaymentsPlaygroundSections,
  type PaymentsPlaygroundTransferView,
} from "./payments-playground-config";
import { deriveTokenOptions } from "./requests/payment-requests-page.data";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./requests/payment-requests-playground-config";

interface PaymentsPlaygroundProps {
  apiBaseUrl?: string | null;
  transfers: PaymentsPlaygroundTransferView[];
  transfersError: string | null;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  counterparties: CounterpartyPlaygroundView[];
  rampProviders: readonly RampProviderId[];
}

/**
 * The one playground for the Payments section: transfers and ramps, then the
 * contact and payment request endpoints, which lost their own playground tabs when those
 * pages became lists.
 */
export function PaymentsPlayground({
  apiBaseUrl,
  transfers,
  transfersError,
  wallets,
  walletsError,
  counterparties,
  rampProviders,
}: PaymentsPlaygroundProps) {
  const t = useTranslations();
  const { sdpEnvironment } = useDashboardWorkspace();
  const endpoints = useMemo(() => {
    const tokens = deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]);
    return mergePaymentsPlaygroundSections(
      {
        payments: buildPaymentsPlaygroundEndpointConfigs({ transfers, wallets, rampProviders }, t),
        contacts: buildCounterpartyPlaygroundEndpointConfigs(counterparties, t),
        requests: buildPaymentRequestsPlaygroundEndpointConfigs(wallets, tokens, t),
      },
      {
        payments: t("DashboardPayments.playground.groupPayments"),
        contacts: t("DashboardPayments.playground.groupContacts"),
        requests: t("DashboardPayments.playground.groupRequests"),
      }
    );
  }, [transfers, wallets, counterparties, rampProviders, sdpEnvironment, t]);

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPayments.playgroundProductName")}
      endpoints={endpoints}
      defaultEndpointId="list-transfers"
      apiBaseUrl={apiBaseUrl}
      leftMessages={[
        ...(walletsError ? [{ text: walletsError, tone: "critical" as const }] : []),
        ...(transfersError ? [{ text: transfersError, tone: "critical" as const }] : []),
      ]}
    />
  );
}
