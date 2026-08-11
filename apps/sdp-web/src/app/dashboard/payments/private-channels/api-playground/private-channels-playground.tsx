"use client";

import { useEffect, useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { buildPrivateChannelsPlaygroundEndpointConfigs } from "./private-channels-playground-config";

interface PrivateChannelsApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface PrivateChannelsPlaygroundProps {
  apiBaseUrl: string | null;
  apiKeys: PrivateChannelsApiKeyOption[];
}

export function PrivateChannelsPlayground({ apiBaseUrl, apiKeys }: PrivateChannelsPlaygroundProps) {
  const t = useTranslations();
  const { selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  const selectedApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );

  const apiKeyValue = useMemo(() => {
    if (!selectedApiKey) return "";
    return (
      getStoredApiKeySecret({
        apiKeyId: selectedApiKey.id,
        keyPrefix: selectedApiKey.keyPrefix,
      }) ?? ""
    );
  }, [selectedApiKey]);

  const endpoints = useMemo(() => buildPrivateChannelsPlaygroundEndpointConfigs(t), [t]);

  return (
    <ApiPlaygroundShell
      productName={t("DashboardPrivateChannels.playground.productName")}
      endpoints={endpoints}
      defaultEndpointId="get-private-channel-instance"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={apiKeys.length === 0}
      leftMessages={[]}
    />
  );
}
