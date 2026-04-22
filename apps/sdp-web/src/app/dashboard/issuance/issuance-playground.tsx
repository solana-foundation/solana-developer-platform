"use client";

import { useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import {
  buildIssuancePlaygroundEndpointConfigs,
  type IssuancePlaygroundTemplateView,
  type IssuancePlaygroundTokenView,
} from "./issuance-playground-config";

interface IssuancePlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyValue: string;
  hasActiveApiKeys: boolean;
  templates: IssuancePlaygroundTemplateView[];
  templatesError: string | null;
  tokens: IssuancePlaygroundTokenView[];
}

export function IssuancePlayground({
  apiBaseUrl,
  apiKeyValue,
  hasActiveApiKeys,
  templates,
  templatesError,
  tokens,
}: IssuancePlaygroundProps) {
  const endpoints = useMemo(
    () => buildIssuancePlaygroundEndpointConfigs({ templates, tokens }),
    [templates, tokens]
  );

  return (
    <ApiPlaygroundShell
      productName="Issuance"
      endpoints={endpoints}
      defaultEndpointId="mint-execute"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={templatesError ? [{ text: templatesError, tone: "critical" }] : []}
    />
  );
}
