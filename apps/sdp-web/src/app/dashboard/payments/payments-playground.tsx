"use client";

import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useMemo } from "react";
import {
  type PaymentsPlaygroundTransferView,
  type PaymentsPlaygroundWalletView,
  buildPaymentsPlaygroundEndpointConfigs,
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
  const endpoints = useMemo(
    () => buildPaymentsPlaygroundEndpointConfigs({ transfers, wallets }),
    [transfers, wallets]
  );

  return (
    <ApiPlaygroundShell
      productName="Payments"
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
