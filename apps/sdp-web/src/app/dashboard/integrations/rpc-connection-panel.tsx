"use client";

import type { OrganizationRpcProvider } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updateOrganizationRpcSettingsAction } from "@/app/dashboard/settings/actions";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { type RpcTestResult, RpcTestResultPanel, runRpcProviderTest } from "@/lib/rpc-connection";
import { rpcProviderLabel } from "@/lib/rpc-providers";
import type { IntegrationStatus } from "./integrations-status";

/**
 * The RPC half of HOO-787: an organization used to have to leave the
 * integration it was reading about and go find the provider dropdown in
 * Settings. The controls live on the provider's own page now.
 *
 * Only the *active* provider gets a test button. `/v1/rpc/test` resolves
 * whatever is saved, so offering it on any other provider's page would report
 * a mismatch against a provider the reader never asked about.
 */
export function RpcConnectionPanel({
  activeProvider,
  canManage,
  isEnabledInDeployment,
  organizationId,
  provider,
  status,
}: {
  activeProvider: OrganizationRpcProvider;
  canManage: boolean;
  /**
   * Whether this deployment actually holds an endpoint for the provider. The
   * catalog marks the organization's saved provider `active` whatever the
   * deployment offers, so a provider dropped from the tier still reads as
   * connected -- and the relay quietly serves someone else.
   */
  isEnabledInDeployment: boolean;
  organizationId: string;
  provider: OrganizationRpcProvider;
  status: IntegrationStatus | "unknown";
}) {
  const t = useTranslations();
  const router = useRouter();
  const [currentProvider, setCurrentProvider] = useState(activeProvider);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [lastTest, setLastTest] = useState<RpcTestResult | null>(null);

  // A server re-render after the switch is the authority; local state only
  // covers the gap before it arrives.
  useEffect(() => {
    setCurrentProvider(activeProvider);
  }, [activeProvider]);

  const isActive = provider === currentProvider;
  // Saved here, but unserviceable: the relay is falling back to another
  // provider, so there is nothing honest to test on this page.
  const isStrandedDefault = isActive && !isEnabledInDeployment;

  const switchToProvider = async () => {
    setIsSwitching(true);
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("rpcProvider", provider);

    try {
      const result = await updateOrganizationRpcSettingsAction(formData);
      if (result.status !== "success") {
        toast.error(t("DashboardCustody.failedToSaveRpcSettings"), {
          description: result.message,
          position: "bottom-right",
        });
        return;
      }

      setCurrentProvider(result.savedRpcProvider ?? provider);
      setLastTest(null);
      toast.success(t("DashboardCustody.rpcSettingsSaved"), {
        description: rpcProviderLabel(result.savedRpcProvider ?? provider),
        position: "bottom-right",
      });
      router.refresh();
    } finally {
      setIsSwitching(false);
    }
  };

  const testProvider = async () => {
    if (isSwitching) {
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
      const result = await runRpcProviderTest(provider, t);
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
        return;
      }

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
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-4" data-rpc-connection={provider}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium tracking-wide text-tertiary uppercase">
            {t("Shared.integrations.rpcActiveProviderLabel")}
          </p>
          <p className="text-sm leading-6 text-secondary">
            {/* A stranded default is selected but not serving, so it must not
                also claim traffic runs through it. */}
            {isStrandedDefault
              ? t("Shared.integrations.rpcActiveSelectedOnly")
              : isActive
                ? t("Shared.integrations.rpcActiveHere")
                : t("Shared.integrations.rpcActiveElsewhere", {
                    provider: rpcProviderLabel(currentProvider),
                  })}
          </p>
        </div>

        {isActive && isEnabledInDeployment && canManage ? (
          <Button
            type="button"
            variant="secondary"
            disabled={isTesting || isSwitching}
            onClick={() => {
              void testProvider();
            }}
          >
            {isTesting ? t("DashboardCustody.testing") : t("Shared.integrations.rpcTestConnection")}
          </Button>
        ) : status === "available" && canManage ? (
          <Button
            type="button"
            disabled={isSwitching}
            onClick={() => {
              void switchToProvider();
            }}
          >
            {isSwitching
              ? t("DashboardCustody.saving")
              : t("Shared.integrations.rpcUseThisProvider")}
          </Button>
        ) : null}
      </div>

      {isStrandedDefault ? (
        <p className="max-w-2xl text-sm leading-6 text-warning">
          {t("Shared.integrations.rpcActiveUnavailable")}
        </p>
      ) : null}

      {!isActive && status === "available" && !canManage ? (
        <p className="max-w-2xl text-sm leading-6 text-tertiary">
          {t("DashboardCustody.viewOnlyRpcSettings")}
        </p>
      ) : null}

      {status === "not_configured" && !isStrandedDefault ? (
        <p className="max-w-2xl text-sm leading-6 text-tertiary">
          {t("Shared.integrations.rpcNotConfiguredHere")}
        </p>
      ) : null}

      {lastTest ? <RpcTestResultPanel result={lastTest} /> : null}
    </div>
  );
}
