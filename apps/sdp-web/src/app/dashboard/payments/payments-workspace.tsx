"use client";

import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { PageBody } from "@/components/layouts";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import type {
  CustodyWalletAggregate,
  PaymentTransferSummary,
  PaymentsDashboardWallet,
} from "@sdp/types";
import dynamic from "next/dynamic";
import { useEffect, useMemo } from "react";
import { PaymentsOverview } from "./payments-overview";

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

interface PaymentsWorkspaceProps {
  apiBaseUrl: string | null;
  apiKeys: PaymentsApiKeyOption[];
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  aggregate: CustodyWalletAggregate | null;
  aggregateError: string | null;
  transfers: PaymentTransferSummary[];
  transfersError: string | null;
}

export function PaymentsWorkspace({
  apiBaseUrl,
  apiKeys,
  wallets,
  walletsError,
  aggregate,
  aggregateError,
  transfers,
  transfersError,
}: PaymentsWorkspaceProps) {
  const { issuanceTab, selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const isPlaygroundTab = issuanceTab === "playground";

  useEffect(() => {
    setPlaygroundApiKeys(apiKeys);
  }, [apiKeys, setPlaygroundApiKeys]);

  useEffect(() => {
    if (isPlaygroundTab) {
      return;
    }

    const preloadPlayground = () => {
      void import("./payments-playground");
    };

    // biome-ignore lint/nursery/noSecrets: requestIdleCallback is a browser API, not a secret.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      const idleId = window.requestIdleCallback(preloadPlayground);
      return () => window.cancelIdleCallback(idleId);
    }

    const timeoutId = globalThis.setTimeout(preloadPlayground, 600);
    return () => globalThis.clearTimeout(timeoutId);
  }, [isPlaygroundTab]);

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

  if (isPlaygroundTab) {
    return (
      <PageBody fill>
        <div className="h-full min-h-0 w-full">
          <PaymentsPlayground
            apiBaseUrl={apiBaseUrl}
            apiKeyValue={playgroundApiKeyValue}
            hasActiveApiKeys={apiKeys.length > 0}
            transfers={transfers}
            transfersError={transfersError}
            wallets={wallets}
            walletsError={walletsError}
          />
        </div>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PaymentsOverview
        wallets={wallets}
        walletsError={walletsError}
        aggregate={aggregate}
        aggregateError={aggregateError}
        transfers={transfers}
        transfersError={transfersError}
      />
    </PageBody>
  );
}
