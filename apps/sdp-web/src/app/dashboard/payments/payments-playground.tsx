"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentsDashboardWallet } from "@sdp/types";
import { useMemo } from "react";
import {
  type ApiPlaygroundEndpointConfig,
  ApiPlaygroundShell,
} from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { usePlaygroundCreateKeyHref } from "@/components/use-playground-create-key-href";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import {
  buildCounterpartyPlaygroundEndpointConfigs,
  type CounterpartyPlaygroundView,
} from "./counterparty/counterparty-playground-config";
import {
  buildPaymentsPlaygroundEndpointConfigs,
  type PaymentsPlaygroundTransferView,
} from "./payments-playground-config";
import { deriveTokenOptions } from "./requests/payment-requests-page.data";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./requests/payment-requests-playground-config";

interface PaymentsPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyId: string | null;
  hasActiveApiKeys: boolean;
  transfers: PaymentsPlaygroundTransferView[];
  transfersError: string | null;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  counterparties: CounterpartyPlaygroundView[];
}

function withGroup(endpoints: ApiPlaygroundEndpointConfig[], group: string) {
  return endpoints.map((endpoint) => ({ ...endpoint, group }));
}

/**
 * The one playground for the Payments section: transfers, ramps and policies, then the
 * contact and payment request endpoints, which lost their own playground tabs when those
 * pages became lists.
 */
export function PaymentsPlayground({
  apiBaseUrl,
  apiKeyId,
  hasActiveApiKeys,
  transfers,
  transfersError,
  wallets,
  walletsError,
  counterparties,
}: PaymentsPlaygroundProps) {
  const t = useTranslations();
  const createApiKeyHref = usePlaygroundCreateKeyHref();
  const { sdpEnvironment } = useDashboardWorkspace();
  const endpoints = useMemo(() => {
    const tokens = deriveTokenOptions(CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment]);
    const merged = [
      ...withGroup(
        buildPaymentsPlaygroundEndpointConfigs({ transfers, wallets }, t),
        t("DashboardPayments.playground.groupPayments")
      ),
      ...withGroup(
        buildCounterpartyPlaygroundEndpointConfigs(counterparties, t),
        t("DashboardPayments.playground.groupContacts")
      ),
      ...withGroup(
        buildPaymentRequestsPlaygroundEndpointConfigs(wallets, tokens, t),
        t("DashboardPayments.playground.groupRequests")
      ),
    ];
    // Catalog entries can repeat across families; the first (curated) one wins.
    const seen = new Set<string>();
    return merged.filter((endpoint) => {
      if (seen.has(endpoint.id)) {
        return false;
      }
      seen.add(endpoint.id);
      return true;
    });
  }, [transfers, wallets, counterparties, sdpEnvironment, t]);

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPayments.playgroundProductName")}
      endpoints={endpoints}
      defaultEndpointId="list-transfers"
      apiBaseUrl={apiBaseUrl}
      apiKeyId={apiKeyId}
      apiKeySelector={<PlaygroundApiKeySelector />}
      createApiKeyHref={createApiKeyHref}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[
        ...(walletsError ? [{ text: walletsError, tone: "critical" as const }] : []),
        ...(transfersError ? [{ text: transfersError, tone: "critical" as const }] : []),
      ]}
    />
  );
}
