"use client";

import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useTranslations } from "@/i18n/provider";
import {
  buildCounterpartyPlaygroundEndpointConfigs,
  type CounterpartyPlaygroundView,
} from "./counterparty-playground-config";

interface CounterpartyPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyId: string | null;
  hasActiveApiKeys: boolean;
  counterparties: CounterpartyPlaygroundView[];
}

export function CounterpartyPlayground({
  apiBaseUrl,
  apiKeyId,
  hasActiveApiKeys,
  counterparties,
}: CounterpartyPlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildCounterpartyPlaygroundEndpointConfigs(counterparties, t),
    [counterparties, t]
  );

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPayments.counterparty.playgroundProductName")}
      endpoints={endpoints}
      defaultEndpointId="list-counterparties"
      apiBaseUrl={apiBaseUrl}
      apiKeyId={apiKeyId}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[]}
    />
  );
}
