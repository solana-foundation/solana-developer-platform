"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";
import { useState } from "react";
import { toast } from "sonner";
import {
  testOrganizationRpcProviderAction,
  updateOrganizationRpcSettingsAction,
} from "./actions";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

export type SettingsOrganization = {
  id: string;
  name: string;
  settings: OrganizationSettings | null;
};

const RPC_PROVIDER_LABELS: Record<OrganizationRpcProvider, string> = {
  alchemy: "Alchemy",
  default: "SDP",
  helius: "Helius",
  quicknode: "QuickNode",
  triton: "Triton",
};

export function OrganizationRpcSettingsForm({
  organization,
}: {
  organization: SettingsOrganization;
}) {
  const rpcProvider = organization.settings?.rpcProvider ?? "default";
  const [selectedProvider, setSelectedProvider] = useState<OrganizationRpcProvider>(rpcProvider);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const testProvider = async () => {
    if (isSaving) {
      toast.error("Save in progress.", {
        description: "Try again in a moment.",
        position: "bottom-right",
      });
      return;
    }

    setIsTesting(true);

    const formData = new FormData();
    formData.set("organizationId", organization.id);
    formData.set("rpcProvider", selectedProvider);

    try {
      const result = await testOrganizationRpcProviderAction(formData);
      const requestedLabel = RPC_PROVIDER_LABELS[result.requestedProvider] ?? result.requestedProvider;
      const resolvedLabel = result.resolvedProvider
        ? (RPC_PROVIDER_LABELS[result.resolvedProvider as OrganizationRpcProvider] ??
            result.resolvedProvider)
        : null;
      const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : null;

      if (result.status === "success") {
        toast.success("RPC check passed.", {
          description: [requestedLabel, latency].filter(Boolean).join(" • "),
          position: "bottom-right",
        });
      } else {
        const isProviderMismatch =
          !!result.resolvedProvider && result.resolvedProvider !== result.requestedProvider;

        toast.error(isProviderMismatch ? "Provider mismatch." : "RPC check failed.", {
          description: isProviderMismatch
            ? `${requestedLabel} requested, ${resolvedLabel ?? "another provider"} resolved.`
            : [resolvedLabel ?? requestedLabel, result.upstreamStatus, latency]
                .filter((value) => value !== undefined && value !== null && value !== "")
                .join(" • "),
          position: "bottom-right",
        });
      }
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

        <div className="grid gap-2">
          <Label htmlFor="rpcProvider">RPC provider</Label>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px] sm:items-center">
            <select
              id="rpcProvider"
              name="rpcProvider"
              className="h-10 w-full min-w-0 rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
              value={selectedProvider}
              disabled={isSaving || isTesting}
              onChange={(event) => {
                const nextProvider = event.currentTarget.value as typeof selectedProvider;
                setSelectedProvider(nextProvider);
                void saveProvider(nextProvider);
              }}
            >
              {ORGANIZATION_RPC_PROVIDERS.map((provider) => (
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
              disabled={isTesting || isSaving}
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
