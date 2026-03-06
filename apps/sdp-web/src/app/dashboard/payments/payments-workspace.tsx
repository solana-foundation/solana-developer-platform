"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { useEffect, useMemo } from "react";
import { PaymentsDestinationAllowlistCard } from "./payments-destination-allowlist-card";
import { PaymentsPlayground } from "./payments-playground";
import { PaymentsTransferCard } from "./payments-transfer-card";
import { usePaymentsWorkspace } from "./use-payments-workspace";

interface PaymentsApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface PaymentsWorkspaceProps {
  apiBaseUrl: string | null;
  apiKeys: PaymentsApiKeyOption[];
}

export function PaymentsWorkspace({ apiBaseUrl, apiKeys }: PaymentsWorkspaceProps) {
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const workspace = usePaymentsWorkspace();

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

  if (issuanceTab === "playground") {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <PaymentsPlayground
          apiBaseUrl={apiBaseUrl}
          apiKeyValue={playgroundApiKeyValue}
          hasActiveApiKeys={apiKeys.length > 0}
          transfers={workspace.recentTransfers}
          wallets={workspace.wallets}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <PaymentsDestinationAllowlistCard
        wallets={workspace.wallets}
        walletsLoading={workspace.walletsLoading}
        walletsError={workspace.walletsError}
        section={workspace.addAddressSection}
      />
      <PaymentsTransferCard
        wallets={workspace.wallets}
        walletsLoading={workspace.walletsLoading}
        section={workspace.transferSection}
      />
    </div>
  );
}
