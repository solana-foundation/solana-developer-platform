"use client";

import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types";
import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";

const PaymentsPlayground = dynamic(
  () => import("./payments-playground").then((module) => module.PaymentsPlayground),
  {
    loading: () => <ApiPlaygroundShellSkeleton />,
  }
);

interface PaymentsApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface PaymentsPlaygroundWorkspaceProps {
  apiBaseUrl: string | null;
  apiKeys: PaymentsApiKeyOption[];
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  transfers: PaymentTransferSummary[];
  transfersError: string | null;
}

export function PaymentsPlaygroundWorkspace({
  apiBaseUrl,
  apiKeys,
  wallets,
  walletsError,
  transfers,
  transfersError,
}: PaymentsPlaygroundWorkspaceProps) {
  const { selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  const selectedPlaygroundApiKey = useMemo(
    () => apiKeys.find((key) => key.id === selectedPlaygroundApiKeyId) ?? null,
    [apiKeys, selectedPlaygroundApiKeyId]
  );
  const selectedPlaygroundApiKeyPrefix = selectedPlaygroundApiKey?.keyPrefix ?? null;
  const playgroundApiKeyValue = useMemo(() => {
    if (!selectedPlaygroundApiKey) {
      return "";
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedPlaygroundApiKey.id,
      keyPrefix: selectedPlaygroundApiKeyPrefix,
    });

    return stored ?? "";
  }, [selectedPlaygroundApiKey, selectedPlaygroundApiKeyPrefix]);

  return (
    <PaymentsPlayground
      apiBaseUrl={apiBaseUrl}
      apiKeyValue={playgroundApiKeyValue}
      hasActiveApiKeys={apiKeys.length > 0}
      transfers={transfers}
      transfersError={transfersError}
      wallets={wallets}
      walletsError={walletsError}
    />
  );
}
