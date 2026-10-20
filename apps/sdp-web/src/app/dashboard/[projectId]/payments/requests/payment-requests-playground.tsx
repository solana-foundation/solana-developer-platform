"use client";

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { useTranslations } from "@/i18n/provider";
import type { PaymentRequestTokenOption } from "./payment-requests-page.data";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./payment-requests-playground-config";

interface PaymentRequestsPlaygroundProps {
  apiBaseUrl?: string | null;
  wallets: PaymentsDashboardWallet[];
  tokens: PaymentRequestTokenOption[];
}

export function PaymentRequestsPlayground({
  apiBaseUrl,
  wallets,
  tokens,
}: PaymentRequestsPlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildPaymentRequestsPlaygroundEndpointConfigs(wallets, tokens, t),
    [wallets, tokens, t]
  );

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPayments.requests.playgroundProductName")}
      endpoints={endpoints}
      defaultEndpointId="list-payment-requests"
      apiBaseUrl={apiBaseUrl}
      leftMessages={[]}
    />
  );
}
