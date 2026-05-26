"use client";

import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import {
  buildCounterpartyPlaygroundEndpointConfigs,
  type CounterpartyPlaygroundView,
} from "./counterparty-playground-config";

interface CounterpartyPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyValue: string;
  hasActiveApiKeys: boolean;
  counterparties: CounterpartyPlaygroundView[];
}

export function CounterpartyPlayground({
  apiBaseUrl,
  apiKeyValue,
  hasActiveApiKeys,
  counterparties,
}: CounterpartyPlaygroundProps) {
  const endpoints = useMemo(
    () => buildCounterpartyPlaygroundEndpointConfigs(counterparties),
    [counterparties]
  );

  return (
    <ApiPlaygroundShell
      productName="Counterparty"
      endpoints={endpoints}
      defaultEndpointId="list-counterparties"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[]}
    />
  );
}
