"use client";

import type { OrganizationRpcProvider } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { type RpcTestResult, RpcTestResultPanel, runRpcProviderTest } from "@/lib/rpc-connection";
import { rpcProviderLabel } from "@/lib/rpc-providers";
import type { IntegrationStatus } from "./integrations-status";
import { switchRpcProviderAction } from "./rpc-connection-actions";

/**
 * What is serving this project, in one sentence, most specific first.
 *
 * Six answers rather than the original two, because the organization's
 * selection and the project's own connection are different questions and the
 * page used to answer only the first while claiming to answer both.
 */
function serviceSummary(
  input: {
    isActive: boolean;
    isStrandedDefault: boolean;
    orgProvider: OrganizationRpcProvider;
    provider: OrganizationRpcProvider;
    servingProvider?: string | null;
  },
  t: ReturnType<typeof useTranslations>
): string {
  const { isActive, isStrandedDefault, orgProvider, provider, servingProvider } = input;

  if (isStrandedDefault) {
    return t("Shared.integrations.rpcActiveSelectedOnly");
  }
  if (servingProvider === provider) {
    return t("Shared.integrations.rpcActiveOwnCredential");
  }
  if (servingProvider) {
    return isActive
      ? t("Shared.integrations.rpcActiveOverridden", {
          provider: rpcProviderLabel(servingProvider),
        })
      : t("Shared.integrations.rpcServedByProject", {
          provider: rpcProviderLabel(servingProvider),
        });
  }
  return isActive
    ? t("Shared.integrations.rpcActiveHere")
    : t("Shared.integrations.rpcActiveElsewhere", { provider: rpcProviderLabel(orgProvider) });
}

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
  hasOwnKey = false,
  isEnabledInDeployment,
  organizationId,
  provider,
  servingProvider,
  status,
}: {
  activeProvider: OrganizationRpcProvider;
  canManage: boolean;
  /**
   * Whether this project holds a live key of its own for this provider. The
   * switch runs on the tenant's endpoint in that case, so a provider this
   * deployment has no URL for is still something they can move to.
   */
  hasOwnKey?: boolean;
  /**
   * The provider actually routing this project, whichever one that is. A
   * tenant connection outranks the organization's selection, so this panel
   * cannot describe what serves the project without it.
   */
  servingProvider?: string | null;
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
  /**
   * Whether this provider is what answers the project right now, which is what
   * `status === "active"` encodes: a tenant connection first, the
   * organization's selection when none serves.
   */
  const isServingProvider = status === "active";
  /**
   * Whether to offer the switch.
   *
   * A key of the tenant's own is enough on its own: it runs on their endpoint,
   * so a provider this deployment holds no URL for is still switchable to when
   * they hold a key for it.
   */
  const canSelect = !isServingProvider && canManage && (isEnabledInDeployment || hasOwnKey);

  const switchToProvider = async () => {
    setIsSwitching(true);
    const formData = new FormData();
    formData.set("organizationId", organizationId);
    formData.set("provider", provider);

    try {
      // One action, both halves: the credential this project routes through and
      // the selection that answers once no connection does. Writing only the
      // second left the button with nothing to show for itself.
      const result = await switchRpcProviderAction(formData);
      if (result.status !== "success") {
        toast.error(t("DashboardCustody.failedToSaveRpcSettings"), {
          description: result.message,
          position: "bottom-right",
        });
        return;
      }

      setCurrentProvider(provider);
      setLastTest(null);
      toast.success(t("DashboardCustody.rpcSettingsSaved"), {
        description: result.usesOwnCredential
          ? t("Shared.integrations.rpcSwitchedToOwnKey", { provider: rpcProviderLabel(provider) })
          : t("Shared.integrations.rpcSwitchedToPlatform", {
              provider: rpcProviderLabel(provider),
            }),
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

      // A mismatch is not a failure, and the result panel says so in amber
      // beside a 200 OK. Raising a red error toast for the same event told the
      // reader two different things at once.
      const notify = isProviderMismatch ? toast.warning : toast.error;
      notify(
        isProviderMismatch
          ? t("DashboardCustody.rpcDetailMismatch")
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
            {serviceSummary(
              {
                isActive,
                isStrandedDefault,
                orgProvider: currentProvider,
                provider,
                servingProvider,
              },
              t
            )}
          </p>
        </div>

        {isServingProvider && !isStrandedDefault && canManage ? (
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
        ) : canSelect ? (
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

      {/* The note that used to sit here explained that choosing a provider
          would not change what serves the project. That is no longer true:
          the switch moves the credential too, so the explanation would be
          describing behaviour the button no longer has. */}
      {isStrandedDefault ? (
        <p className="max-w-2xl text-sm leading-6 text-warning">
          {t("Shared.integrations.rpcActiveUnavailable")}
        </p>
      ) : null}

      {!isActive && isEnabledInDeployment && !canManage ? (
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
