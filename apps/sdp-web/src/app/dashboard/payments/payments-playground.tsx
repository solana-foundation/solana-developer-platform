"use client";

import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useTranslations } from "@/i18n/provider";
import {
  buildPaymentsPlaygroundEndpointConfigs,
  type PaymentsPlaygroundTransferView,
  type PaymentsPlaygroundWalletView,
} from "./payments-playground-config";

interface PaymentsPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyValue: string;
  hasActiveApiKeys: boolean;
  transfers: PaymentsPlaygroundTransferView[];
  transfersError: string | null;
  wallets: PaymentsPlaygroundWalletView[];
  walletsError: string | null;
}

export function PaymentsPlayground({
  apiBaseUrl,
  apiKeyValue,
  hasActiveApiKeys,
  transfers,
  transfersError,
  wallets,
  walletsError,
}: PaymentsPlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildPaymentsPlaygroundEndpointConfigs({ transfers, wallets }, t),
    [transfers, wallets, t]
  );

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPayments.playgroundProductName")}
      endpoints={endpoints}
      defaultEndpointId="execute-transfer"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[
        ...(walletsError ? [{ text: walletsError, tone: "critical" as const }] : []),
        ...(transfersError ? [{ text: transfersError, tone: "critical" as const }] : []),
      ]}
    />
  );
}
