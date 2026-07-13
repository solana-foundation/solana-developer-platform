"use client";

import { useMemo } from "react";
import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useTranslations } from "@/i18n/provider";
import {
  buildWalletsPlaygroundEndpointConfigs,
  type WalletsPlaygroundWalletView,
} from "./wallets-playground-config";

interface WalletsPlaygroundProps {
  apiBaseUrl?: string | null;
  apiKeyValue: string;
  connectedProviders: KnownCustodyProvider[];
  configsError: string | null;
  hasActiveApiKeys: boolean;
  wallets: WalletsPlaygroundWalletView[];
  walletsError: string | null;
}

export function WalletsPlayground({
  apiBaseUrl,
  apiKeyValue,
  connectedProviders,
  configsError,
  hasActiveApiKeys,
  wallets,
  walletsError,
}: WalletsPlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildWalletsPlaygroundEndpointConfigs({ connectedProviders, wallets, t }),
    [connectedProviders, t, wallets]
  );

  return (
    <ApiPlaygroundShell
      productName={t("DashboardCustody.wallets")}
      endpoints={endpoints}
      defaultEndpointId="list-wallets"
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={apiKeyValue}
      apiKeySelector={<PlaygroundApiKeySelector />}
      requiresApiKey={!hasActiveApiKeys}
      leftMessages={[
        ...(configsError ? [{ text: configsError, tone: "critical" as const }] : []),
        ...(walletsError ? [{ text: walletsError, tone: "critical" as const }] : []),
      ]}
    />
  );
}
