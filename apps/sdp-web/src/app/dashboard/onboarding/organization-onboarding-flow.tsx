"use client";

import type { CustodyProvider, OrganizationRpcProvider } from "@sdp/types";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { Button } from "@/components/ui/button";
import { ProviderSelectionCard } from "@/components/ui/provider-selection-card";
import { WizardStepProgress } from "@/components/ui/wizard-step-progress";
import { useTranslations } from "@/i18n/provider";
import { useDashboardRouter } from "@/lib/use-dashboard-router";
import { completeOrganizationOnboardingAction, saveOnboardingRpcAction } from "./actions";
import { RpcProviderMark } from "./rpc-provider-mark";

const RPC_LABELS: Record<OrganizationRpcProvider, string> = {
  alchemy: "Alchemy",
  default: "SDP RPC",
  helius: "Helius",
  nodit: "Nodit",
  quicknode: "QuickNode",
  triton: "Triton",
  validationcloud: "Validation Cloud",
};

const RPC_DESCRIPTION_KEYS: Record<
  OrganizationRpcProvider,
  | "DashboardCustody.onboardingRpcDefaultDescription"
  | "DashboardCustody.onboardingRpcAlchemyDescription"
  | "DashboardCustody.onboardingRpcHeliusDescription"
  | "DashboardCustody.onboardingRpcNoditDescription"
  | "DashboardCustody.onboardingRpcQuickNodeDescription"
  | "DashboardCustody.onboardingRpcTritonDescription"
  | "DashboardCustody.onboardingRpcValidationCloudDescription"
> = {
  alchemy: "DashboardCustody.onboardingRpcAlchemyDescription",
  default: "DashboardCustody.onboardingRpcDefaultDescription",
  helius: "DashboardCustody.onboardingRpcHeliusDescription",
  nodit: "DashboardCustody.onboardingRpcNoditDescription",
  quicknode: "DashboardCustody.onboardingRpcQuickNodeDescription",
  triton: "DashboardCustody.onboardingRpcTritonDescription",
  validationcloud: "DashboardCustody.onboardingRpcValidationCloudDescription",
};

const ONBOARDING_STEPS = ["rpc", "custody"] as const;

export function OrganizationOnboardingFlow({
  organizationId,
  currentStep: initialStep,
  initialRpcProvider,
  rpcProviders,
  custodyProviders,
}: {
  organizationId: string;
  currentStep: "rpc" | "custody";
  initialRpcProvider: OrganizationRpcProvider | null;
  rpcProviders: OrganizationRpcProvider[];
  custodyProviders: CustodyProvider[];
}) {
  const t = useTranslations();
  const router = useDashboardRouter();
  const [isPending, startTransition] = useTransition();
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [rpcProvider, setRpcProvider] = useState<OrganizationRpcProvider | null>(
    initialRpcProvider === "default" ? null : initialRpcProvider
  );
  const [custodyProvider, setCustodyProvider] = useState<CustodyProvider | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const custodyEntries = useMemo(() => {
    const providers = new Set(custodyProviders);
    return CUSTODY_PROVIDER_CATALOG.filter((entry) => providers.has(entry.id));
  }, [custodyProviders]);
  const visibleRpcProviders = useMemo(
    () => rpcProviders.filter((provider) => provider !== "default"),
    [rpcProviders]
  );

  const submitRpc = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rpcProvider || isPending) return;
    setErrorMessage(null);
    startTransition(async () => {
      const result = await saveOnboardingRpcAction({ organizationId, rpcProvider });
      if (result.status === "error") {
        setErrorMessage(result.message);
        return;
      }
      setCurrentStep("custody");
      router.refresh();
    });
  };

  const submitCustody = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!custodyProvider || isPending) return;
    setErrorMessage(null);
    startTransition(async () => {
      const result = await completeOrganizationOnboardingAction(custodyProvider);
      if (result.status === "error") {
        setErrorMessage(result.message);
        return;
      }
      router.refresh();
      router.push("/dashboard");
    });
  };

  const stepIndex = ONBOARDING_STEPS.indexOf(currentStep);
  const formId = `organization-onboarding-${currentStep}`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-organization-onboarding="true">
      <div className="shrink-0 px-4 pt-7 pb-6 md:px-8">
        <div className="mx-auto w-full max-w-4xl">
          <p className="text-sm font-medium text-secondary">
            {t("DashboardCustody.onboardingEyebrow")}
          </p>
          <h1 className="mt-2 text-[32px] leading-tight font-medium tracking-tight text-primary">
            {t("DashboardCustody.onboardingTitle")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
            {t("DashboardCustody.onboardingDescription")}
          </p>
          <div className="mt-7">
            <WizardStepProgress
              currentStep={stepIndex}
              progressLabel={t("DashboardCustody.stepOf", {
                current: stepIndex + 1,
                total: ONBOARDING_STEPS.length,
              })}
              steps={ONBOARDING_STEPS}
            />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-8">
        <div className="mx-auto w-full max-w-4xl pb-10">
          <div className="mb-6">
            <h2 className="text-2xl font-medium tracking-tight text-primary">
              {currentStep === "rpc"
                ? t("DashboardCustody.onboardingChooseRpc")
                : t("DashboardCustody.onboardingChooseCustody")}
            </h2>
            <p className="mt-1 text-sm leading-6 text-tertiary">
              {t("DashboardCustody.onboardingProvidersChangeLater")}
            </p>
          </div>

          {currentStep === "rpc" ? (
            <form id={formId} onSubmit={submitRpc} className="grid gap-4 md:grid-cols-2">
              {visibleRpcProviders.length === 0 ? (
                <div
                  role="alert"
                  className="md:col-span-2 rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
                >
                  {t("DashboardCustody.onboardingNoRpcProviders")}
                </div>
              ) : null}
              {visibleRpcProviders.map((provider) => (
                <ProviderSelectionCard
                  key={provider}
                  isSelected={rpcProvider === provider}
                  onSelect={() => {
                    setRpcProvider(provider);
                    setErrorMessage(null);
                  }}
                  icon={<RpcProviderMark provider={provider} />}
                  title={RPC_LABELS[provider]}
                  description={t(RPC_DESCRIPTION_KEYS[provider])}
                />
              ))}
            </form>
          ) : (
            <form id={formId} onSubmit={submitCustody} className="grid gap-4 md:grid-cols-2">
              {custodyEntries.length === 0 ? (
                <div
                  role="alert"
                  className="md:col-span-2 rounded-2xl border border-border-default bg-fill-subtle px-5 py-4 text-sm leading-6 text-secondary"
                >
                  {t("DashboardCustody.onboardingNoCustodyProviders")}
                </div>
              ) : null}
              {custodyEntries.map((provider: CustodyProviderCatalogEntry) => (
                <ProviderSelectionCard
                  key={provider.id}
                  isSelected={custodyProvider === provider.id}
                  onSelect={() => {
                    setCustodyProvider(provider.id);
                    setErrorMessage(null);
                  }}
                  icon={<WalletProviderMark provider={provider.id} size="sm" />}
                  title={provider.label}
                  description={t(provider.descriptionKey)}
                />
              ))}
            </form>
          )}

          {errorMessage ? (
            <div
              role="alert"
              className="mt-5 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error"
            >
              {errorMessage}
            </div>
          ) : null}
        </div>
      </div>

      <footer
        className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-8"
        data-organization-onboarding-actions="true"
      >
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
          {currentStep === "custody" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCurrentStep("rpc");
                setErrorMessage(null);
              }}
              disabled={isPending}
              iconLeft={<ArrowLeft className="size-4" />}
            >
              {t("DashboardCustody.back")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            form={formId}
            disabled={(currentStep === "rpc" ? !rpcProvider : !custodyProvider) || isPending}
            iconRight={currentStep === "rpc" ? <ArrowRight className="size-4" /> : undefined}
          >
            {isPending
              ? t("DashboardCustody.onboardingSaving")
              : currentStep === "rpc"
                ? t("DashboardCustody.next")
                : t("DashboardCustody.onboardingFinish")}
          </Button>
        </div>
      </footer>
    </div>
  );
}
