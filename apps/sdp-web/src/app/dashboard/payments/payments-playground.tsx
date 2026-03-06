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
  wallets: PaymentsPlaygroundWalletView[];
}

export function PaymentsPlayground({
  apiBaseUrl,
  apiKeyValue,
  hasActiveApiKeys,
  transfers,
  wallets,
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
      rightMessages={
        hasActiveApiKeys
          ? []
          : [
              {
                text: "No active API keys found. Session auth will be used unless you attach a stored key.",
                tone: "critical",
              },
            ]
      }
    />
  );
}
