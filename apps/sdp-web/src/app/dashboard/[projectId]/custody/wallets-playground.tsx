"use client";

import { useMemo } from "react";
import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { useTranslations } from "@/i18n/provider";
import {
  buildWalletsPlaygroundEndpointConfigs,
  type WalletsPlaygroundWalletView,
} from "./wallets-playground-config";

interface WalletsPlaygroundProps {
  apiBaseUrl?: string | null;
  connectedProviders: KnownCustodyProvider[];
  configsError: string | null;
  wallets: WalletsPlaygroundWalletView[];
  walletsError: string | null;
}

export function WalletsPlayground({
  apiBaseUrl,
  connectedProviders,
  configsError,
  wallets,
  walletsError,
}: WalletsPlaygroundProps) {
  const t = useTranslations();
  const endpoints = useMemo(
    () => buildWalletsPlaygroundEndpointConfigs({ connectedProviders, wallets, t }),
    [connectedProviders, t, wallets]
  );

  return (
    <div className="contents" data-wallet-panel="playground-ready">
      <ApiPlaygroundShell
        productName={t("DashboardCustody.wallets")}
        endpoints={endpoints}
        defaultEndpointId="list-wallets"
        apiBaseUrl={apiBaseUrl}
        leftMessages={[
          ...(configsError ? [{ text: configsError, tone: "critical" as const }] : []),
          ...(walletsError ? [{ text: walletsError, tone: "critical" as const }] : []),
        ]}
      />
    </div>
  );
}
