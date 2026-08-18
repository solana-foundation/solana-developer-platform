"use client";

import { useEffect, useMemo } from "react";
import { ApiPlaygroundShell } from "@/components/api-playground-shell";
import { PlaygroundApiKeySelector } from "@/components/playground-api-key-selector";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import type { PlaygroundApiKeyView } from "../../playground-api-data";
import { buildEarnPlaygroundEndpointConfigs } from "./earn-playground-config";
import { useEarnPrograms } from "./earn-program-data";

/**
 * Earn's API playground — a PERMANENT reference tab, not a step in a flow.
 *
 * It replaces the integration screen the deposit wizard used to show once, at
 * the end of a create run: a partner needs the request shapes while they are
 * building, not in the one moment after they provisioned a program. Modelled on
 * the counterparty playground, down to the key selector and the
 * `requiresApiKey` notice.
 *
 * The program picker is populated from the organization's OWN programs, so the
 * `{programId}` path field is a dropdown rather than a placeholder a reader has
 * to go and find. It reads them through the same hook the Positions tab uses —
 * no second fetch, and no provider filter, so a program held with an
 * un-surfaced provider is still addressable here.
 */
export function EarnPlayground({
  apiBaseUrl,
  apiKeys,
}: {
  apiBaseUrl: string | null;
  apiKeys: readonly PlaygroundApiKeyView[];
}) {
  const t = useTranslations();
  const { selectedPlaygroundApiKeyId, setPlaygroundApiKeys } = useDashboardWorkspace();
  const { state } = useEarnPrograms();

  useEffect(() => {
    setPlaygroundApiKeys([...apiKeys]);
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
        keyPrefix: selectedApiKey.keyPrefix ?? null,
      }) ?? ""
    );
  }, [selectedApiKey]);

  const programs = useMemo(
    () =>
      state?.kind === "ready"
        ? state.programs.map((program) => ({
            id: program.id,
            // The operator's own label when they set one, else the id — this is
            // an id picker, so the id is a useful label rather than a fallback
            // of last resort.
            label: program.label ?? program.id,
          }))
        : [],
    [state]
  );

  const endpoints = useMemo(() => buildEarnPlaygroundEndpointConfigs(programs, t), [programs, t]);

  return (
    <ApiPlaygroundShell
      apiBaseUrl={apiBaseUrl}
      apiKeySelector={<PlaygroundApiKeySelector />}
      apiKeyValue={apiKeyValue}
      defaultEndpointId="list-earn-strategies"
      endpoints={endpoints}
      leftMessages={[]}
      productName={t("DashboardEarn.playground.productName")}
      requiresApiKey={apiKeys.length === 0}
    />
  );
}
