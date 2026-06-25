"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import type { PaymentRequestTokenOption } from "./payment-requests-page.data";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./payment-requests-playground-config";

interface PaymentRequestsPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyValue: string;
  hasActiveApiKeys: boolean;
  wallets: PaymentsDashboardWallet[];
  tokens: PaymentRequestTokenOption[];
}

export function PaymentRequestsPlayground({
  apiBaseUrl,
  apiKeyValue,
  hasActiveApiKeys,
  wallets,
  tokens,
}: PaymentRequestsPlaygroundProps) {
  const endpoints = useMemo(
    () => buildPaymentRequestsPlaygroundEndpointConfigs(wallets, tokens),
    [wallets, tokens]
  );

  return (
    <ApiPlaygroundShell
      productName="Payment Requests"
      endpoints={endpoints}
      defaultEndpointId="list-payment-requests"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[]}
    />
  );
}
