"use client";

import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { updateOrganizationRpcSettingsAction } from "./actions";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

export type SettingsOrganization = {
  id: string;
  name: string;
  settings: OrganizationSettings | null;
};

type RpcProxyResponse = {
  provider: {
    id: string;
    selectionMode: string;
    endpoint: string;
  };
  upstream: {
    ok: boolean;
    status: number;
    statusText: string;
  };
};

type RpcTestResult = {
  status: "success" | "error";
  message: string;
  requestedProvider: OrganizationRpcProvider;
  resolvedProvider?: string;
  selectionMode?: string;
  endpoint?: string;
  upstreamStatus?: number;
  upstreamStatusText?: string;
  latencyMs?: number;
};

function toRpcTestErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Failed to test RPC provider.";
}

async function runRpcProviderTest(
  requestedProvider: OrganizationRpcProvider
): Promise<RpcTestResult> {
  const startedAt = Date.now();

  try {
    const executeResponse = await fetch("/api/playground/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "POST",
        path: "/v1/rpc/test",
        body: {
          jsonrpc: "2.0",
          id: "org-rpc-test",
          method: "getVersion",
          params: [],
        },
        apiKey: null,
      }),
    });

    const latencyMs = Date.now() - startedAt;
    const envelope = (await executeResponse.json()) as {
      ok?: boolean;
      status?: number;
      statusText?: string;
      body?: {
        data?: RpcProxyResponse;
        error?: { message?: string };
      };
      error?: string;
    };

    if (!executeResponse.ok || envelope.status === undefined || envelope.statusText === undefined) {
      return {
        status: "error",
        message: envelope.error ?? "RPC test failed.",
        requestedProvider,
        latencyMs,
      };
    }

    if (!envelope.ok || !envelope.body?.data) {
      return {
        status: "error",
        message: envelope.body?.error?.message || `RPC test failed (${envelope.status}).`,
        requestedProvider,
        latencyMs,
      };
    }

    const {
      provider: { id: resolvedProvider, endpoint, selectionMode },
      upstream,
    } = envelope.body.data;

    if (requestedProvider !== "default" && resolvedProvider !== requestedProvider) {
      return {
        status: "error",
        message: `RPC test mismatch (requested ${requestedProvider}, resolved ${resolvedProvider}).`,
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    if (!upstream.ok) {
      return {
        status: "error",
        message: `RPC upstream returned ${upstream.status} ${upstream.statusText}.`,
        requestedProvider,
        resolvedProvider,
        selectionMode,
        endpoint,
        upstreamStatus: upstream.status,
        upstreamStatusText: upstream.statusText,
        latencyMs,
      };
    }

    return {
      status: "success",
      message: `RPC test passed (${upstream.status} ${upstream.statusText}) in ${latencyMs}ms.`,
      requestedProvider,
      resolvedProvider,
      selectionMode,
      endpoint,
      upstreamStatus: upstream.status,
      upstreamStatusText: upstream.statusText,
      latencyMs,
    };
  } catch (error) {
    return {
      status: "error",
      message: toRpcTestErrorMessage(error),
      requestedProvider,
      latencyMs: Date.now() - startedAt,
    };
  }
}

const RPC_PROVIDER_LABELS: Record<OrganizationRpcProvider, string> = {
  alchemy: "Alchemy",
  default: "SDP",
  helius: "Helius",
  quicknode: "QuickNode",
  triton: "Triton",
};

export function OrganizationRpcSettingsForm({
  canManageSettings,
  enabledProviders,
  organization,
}: {
  canManageSettings: boolean;
  enabledProviders: OrganizationRpcProvider[];
  organization: SettingsOrganization;
}) {
  const rpcProvider = organization.settings?.rpcProvider ?? "default";
  const availableProviders = useMemo(
    () =>
      ORGANIZATION_RPC_PROVIDERS.filter((provider) =>
        enabledProviders.includes(provider)
      ) as OrganizationRpcProvider[],
    [enabledProviders]
  );
  const hasEnabledProviders = availableProviders.length > 0;
  const fallbackProvider =
    availableProviders.find((provider) => provider === "default") ??
    availableProviders[0] ??
    "default";
  const hasPersistedProviderEnabled =
    hasEnabledProviders && availableProviders.includes(rpcProvider);
  const [selectedProvider, setSelectedProvider] = useState<OrganizationRpcProvider>(
    hasPersistedProviderEnabled ? rpcProvider : fallbackProvider
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isApplyingFallback, setIsApplyingFallback] = useState(false);

  useEffect(() => {
    setSelectedProvider(hasPersistedProviderEnabled ? rpcProvider : fallbackProvider);
  }, [fallbackProvider, hasPersistedProviderEnabled, rpcProvider]);

  const saveProvider = async (provider: OrganizationRpcProvider) => {
    setIsSaving(true);
    const formData = new FormData();
    formData.set("organizationId", organization.id);
    formData.set("rpcProvider", provider);

    try {
      const result = await updateOrganizationRpcSettingsAction(formData);
      if (result.status !== "success") {
        setErrorMessage(result.message || "Failed to save RPC settings.");
        return;
      }

      setErrorMessage(null);
      setSelectedProvider(result.savedRpcProvider ?? provider);
    } finally {
      setIsSaving(false);
    }
  };

  const applyFallbackProvider = async () => {
    setIsApplyingFallback(true);
    try {
      await saveProvider(fallbackProvider);
    } finally {
      setIsApplyingFallback(false);
    }
  };

  const testProvider = async () => {
    if (isSaving) {
      toast.error("Save in progress.", {
        description: "Try again in a moment.",
        position: "bottom-right",
      });
      return;
    }

    setIsTesting(true);
    const toastId = toast.loading("Checking RPC provider.", {
      position: "bottom-right",
    });

    try {
      const result = await runRpcProviderTest(selectedProvider);
      const requestedLabel =
        RPC_PROVIDER_LABELS[result.requestedProvider] ?? result.requestedProvider;
      const resolvedLabel = result.resolvedProvider
        ? (RPC_PROVIDER_LABELS[result.resolvedProvider as OrganizationRpcProvider] ??
          result.resolvedProvider)
        : null;
      const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : null;

      if (result.status === "success") {
        toast.success("RPC check passed.", {
          id: toastId,
          description: [requestedLabel, latency].filter(Boolean).join(" • "),
          position: "bottom-right",
        });
      } else {
        const isProviderMismatch =
          result.requestedProvider !== "default" &&
          !!result.resolvedProvider &&
          result.resolvedProvider !== result.requestedProvider;

        toast.error(isProviderMismatch ? "Provider mismatch." : "RPC check failed.", {
          id: toastId,
          description: isProviderMismatch
            ? `${requestedLabel} requested, ${resolvedLabel ?? "another provider"} resolved.`
            : [resolvedLabel ?? requestedLabel, result.upstreamStatus, latency]
                .filter((value) => value !== undefined && value !== null && value !== "")
                .join(" • "),
          position: "bottom-right",
        });
      }
    } catch (error) {
      toast.error("RPC check failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "RPC check failed.",
        position: "bottom-right",
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="w-full max-w-3xl space-y-5">
        <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-sm text-[rgba(28,28,29,0.7)]">
              Editing organization: {organization.name}
            </span>
          </div>
        </div>

        {!canManageSettings ? (
          <div className="rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-3 py-2 text-sm text-[rgba(28,28,29,0.72)]">
            You can view organization RPC settings, but only admins can change them.
          </div>
        ) : null}

        {!hasEnabledProviders ? (
          <div className="rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
            No RPC providers are enabled for this organization in the current environment.
          </div>
        ) : null}

        {hasEnabledProviders && !hasPersistedProviderEnabled ? (
          <div className="rounded-xl border border-[rgba(180,83,9,0.22)] bg-[rgba(245,158,11,0.12)] px-3 py-2 text-sm text-[#8a5a00]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>
                The saved RPC provider for this organization is no longer available on the current
                tier. The form has fallen back to {RPC_PROVIDER_LABELS[fallbackProvider]} until you
                save an enabled provider.
              </p>
              {canManageSettings ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={isSaving || isTesting || isApplyingFallback}
                  onClick={() => {
                    void applyFallbackProvider();
                  }}
                >
                  {isApplyingFallback ? "Saving..." : "Save fallback"}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          <Label htmlFor="rpcProvider">RPC provider</Label>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px] sm:items-center">
            <select
              id="rpcProvider"
              name="rpcProvider"
              className="h-10 w-full min-w-0 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
              value={selectedProvider}
              disabled={!canManageSettings || !hasEnabledProviders || isSaving || isTesting}
              onChange={(event) => {
                const nextProvider = event.currentTarget.value as typeof selectedProvider;
                setSelectedProvider(nextProvider);
                void saveProvider(nextProvider);
              }}
            >
              {availableProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {RPC_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="w-full sm:w-[112px] sm:justify-center"
              disabled={!hasEnabledProviders || isTesting || isSaving}
              onClick={() => {
                void testProvider();
              }}
            >
              {isTesting ? "Testing..." : "Test RPC"}
            </Button>
          </div>
        </div>
      </div>

      {errorMessage ? (
        <div className="w-full max-w-3xl rounded-xl border border-[rgba(158,43,56,0.2)] bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
