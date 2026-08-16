"use client";

import { ORGANIZATION_RPC_PROVIDERS, type OrganizationRpcProvider } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RpcProviderMark } from "@/app/dashboard/onboarding/rpc-provider-mark";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import { type RpcTestResult, RpcTestResultPanel, runRpcProviderTest } from "@/lib/rpc-connection";
import { RPC_PROVIDER_LABELS, rpcProviderLabel } from "@/lib/rpc-providers";
import { updateOrganizationRpcSettingsAction } from "./actions";

type OrganizationSettings = {
  rpcProvider?: OrganizationRpcProvider;
};

export type SettingsOrganization = {
  id: string;
  name: string;
  settings: OrganizationSettings | null;
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
  const t = useTranslations();
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
  const [lastTest, setLastTest] = useState<RpcTestResult | null>(null);

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
        setErrorMessage(result.message || t("DashboardCustody.failedToSaveRpcSettings"));
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
      toast.error(t("DashboardCustody.saveInProgress"), {
        description: t("DashboardCustody.tryAgainSoon"),
        position: "bottom-right",
      });
      return;
    }

    setIsTesting(true);
    const toastId = toast.loading(t("DashboardCustody.checkingRpcProvider"), {
      position: "bottom-right",
    });

    try {
      const result = await runRpcProviderTest(selectedProvider, t);
      setLastTest(result);
      const requestedLabel = rpcProviderLabel(result.requestedProvider);
      const resolvedLabel = result.resolvedProvider
        ? rpcProviderLabel(result.resolvedProvider)
        : null;
      const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : null;

      if (result.status === "success") {
        toast.success(t("DashboardCustody.rpcCheckPassed"), {
          id: toastId,
          description: [requestedLabel, latency].filter(Boolean).join(" • "),
          position: "bottom-right",
        });
      } else {
        const isProviderMismatch =
          result.requestedProvider !== "default" &&
          !!result.resolvedProvider &&
          result.resolvedProvider !== result.requestedProvider;

        toast.error(
          isProviderMismatch
            ? t("DashboardCustody.providerMismatch")
            : t("DashboardCustody.rpcCheckFailed"),
          {
            id: toastId,
            description: isProviderMismatch
              ? t("DashboardCustody.rpcTestMismatch", {
                  requested: requestedLabel,
                  resolved: resolvedLabel ?? t("DashboardCustody.anotherProvider"),
                })
              : [resolvedLabel ?? requestedLabel, result.upstreamStatus, latency]
                  .filter((value) => value !== undefined && value !== null && value !== "")
                  .join(" • "),
            position: "bottom-right",
          }
        );
      }
    } catch (error) {
      toast.error(t("DashboardCustody.rpcCheckFailed"), {
        id: toastId,
        description: error instanceof Error ? error.message : t("DashboardCustody.rpcCheckFailed"),
        position: "bottom-right",
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="w-full space-y-5">
        <div className="flex h-10 w-full items-center rounded-xl border border-border-default bg-fill-subtle px-3 text-sm text-secondary">
          {t("DashboardCustody.editingOrganization", { name: organization.name })}
        </div>

        {!canManageSettings ? (
          <div className="rounded-xl border border-border-default bg-fill-subtle px-3 py-2 text-sm text-secondary">
            {t("DashboardCustody.viewOnlyRpcSettings")}
          </div>
        ) : null}

        {!hasEnabledProviders ? (
          <div className="rounded-xl border border-destructive-border bg-destructive-bg px-3 py-2 text-sm text-destructive-strong">
            {t("DashboardCustody.noRpcProviders")}
          </div>
        ) : null}

        {hasEnabledProviders && !hasPersistedProviderEnabled ? (
          <div className="rounded-xl border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>
                {t("DashboardCustody.rpcFallback", {
                  provider: RPC_PROVIDER_LABELS[fallbackProvider],
                })}
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
                  {isApplyingFallback
                    ? t("DashboardCustody.saving")
                    : t("DashboardCustody.saveFallback")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid gap-2">
          {/* Not a <label>: the DS Select has no associable id, so a bound label
              would be a dead click target. The Select carries its own ariaLabel. */}
          <span className="text-sm font-medium text-primary">
            {t("DashboardCustody.rpcProvider")}
          </span>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_112px] sm:items-center">
            <Select
              ariaLabel={t("DashboardCustody.rpcProvider")}
              className="w-full"
              value={selectedProvider}
              disabled={!canManageSettings || !hasEnabledProviders || isSaving || isTesting}
              onValueChange={(value) => {
                if (!value) return;
                const nextProvider = value as typeof selectedProvider;
                setSelectedProvider(nextProvider);
                void saveProvider(nextProvider);
              }}
            >
              {availableProviders.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  <span className="flex items-center gap-2">
                    <RpcProviderMark provider={provider} />
                    {RPC_PROVIDER_LABELS[provider]}
                  </span>
                </SelectItem>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              className="w-full sm:justify-center"
              disabled={!hasEnabledProviders || isTesting || isSaving}
              onClick={() => {
                void testProvider();
              }}
            >
              {isTesting ? t("DashboardCustody.testing") : t("DashboardCustody.testRpc")}
            </Button>
          </div>
        </div>

        {lastTest ? <RpcTestResultPanel result={lastTest} /> : null}
      </div>

      {errorMessage ? (
        <div className="w-full rounded-xl border border-destructive-border bg-destructive-bg px-3 py-2 text-sm text-destructive-strong">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
