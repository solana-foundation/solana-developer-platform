"use client";

import { Button } from "@/components/ui/button";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { getStoredApiKeySecret } from "@/lib/playground-api-keys";
import { KeyRound } from "lucide-react";
import Link from "next/link";

function formatKeyIdentifier(keyPrefix: string): string {
  const trimmed = keyPrefix.trim();
  if (!trimmed) {
    return "api_key...";
  }

  if (trimmed.endsWith("...")) {
    return trimmed;
  }

  if (trimmed.length <= 12) {
    return `${trimmed}...`;
  }

  return `${trimmed.slice(0, 12)}...`;
}

function formatApiKeyLabel(name: string, keyPrefix: string): string {
  return `${name} (${formatKeyIdentifier(keyPrefix)})`;
}

export function PlaygroundApiKeySelector() {
  const {
    dashboardAccess,
    playgroundApiKeys,
    selectedPlaygroundApiKeyId,
    setSelectedPlaygroundApiKeyId,
  } = useDashboardWorkspace();
  const selectedApiKey =
    playgroundApiKeys.find((apiKey) => apiKey.id === selectedPlaygroundApiKeyId) ??
    playgroundApiKeys[0];

  if (playgroundApiKeys.length === 0) {
    return (
      <div className="flex w-full flex-wrap items-center justify-end gap-3 lg:max-w-[420px]">
        <div className="inline-flex h-11 min-w-[260px] flex-1 items-center gap-2 rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[rgba(28,28,29,0.56)]">
          <KeyRound className="h-4 w-4" />
          <span>No API keys</span>
        </div>
        {dashboardAccess.capabilities.canManageApiKeys ? (
          <Button asChild className="h-11 rounded-[14px] px-4 whitespace-nowrap">
            <Link href="/dashboard/api-keys">Create API key</Link>
          </Button>
        ) : null}
      </div>
    );
  }

  const selectedApiKeySecret = selectedApiKey
    ? getStoredApiKeySecret({
        apiKeyId: selectedApiKey.id,
        keyPrefix: selectedApiKey.keyPrefix,
      })
    : null;

  return (
    <div className="w-full min-w-[260px] lg:max-w-[360px]">
      <div className="relative">
        <div className="pointer-events-none flex h-11 w-full items-center rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none">
          <span className="flex min-w-0 items-center gap-2 pr-8">
            <KeyRound className="h-4 w-4 text-[rgba(28,28,29,0.58)]" />
            <span className="truncate text-left text-sm font-medium text-[#1c1c1d]">
              {selectedApiKey
                ? formatApiKeyLabel(selectedApiKey.name, selectedApiKey.keyPrefix)
                : "Select API key"}
            </span>
          </span>
        </div>

        <select
          aria-label="Select API key"
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[14px] opacity-0"
          value={selectedPlaygroundApiKeyId ?? playgroundApiKeys[0].id}
          onChange={(event) => setSelectedPlaygroundApiKeyId(event.currentTarget.value)}
        >
          {playgroundApiKeys.map((apiKey) => (
            <option key={apiKey.id} value={apiKey.id}>
              {formatApiKeyLabel(apiKey.name, apiKey.keyPrefix)}
            </option>
          ))}
        </select>

        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-[rgba(28,28,29,0.42)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </div>

      {!selectedApiKeySecret && selectedApiKey ? (
        <p className="mt-2 text-xs leading-5 text-[rgba(28,28,29,0.62)]">
          This browser session does not have the raw secret for this key yet. The playground will
          fall back to your current dashboard session until you{" "}
          <Link href="/dashboard/api-keys" className="font-medium text-[#1c1c1d] underline">
            create or rotate the key
          </Link>{" "}
          and copy the full{" "}
          <code className="rounded bg-[rgba(28,28,29,0.06)] px-1 py-0.5">sk_...</code> value.
        </p>
      ) : null}
    </div>
  );
}
