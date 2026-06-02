"use client";

import type { ComplianceProviderId, PaymentsDashboardWallet, RampProviderId } from "@sdp/types";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { RAMP_PROVIDER_LOGOS, RAMP_PROVIDER_OPTIONS } from "@/lib/ramps";
import { cn } from "@/lib/utils";
import { CounterpartyCreateDialog } from "./counterparty/counterparty-create-dialog";
import type { CounterpartiesResult } from "./payments-workspace.data";
import { OnrampStepContent } from "./ramps/components/onramp-step-content";
import { STEPS, useOnrampWizard } from "./use-onramp-wizard";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  actionLabel?: string;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
}

function getRampProviderLabel(provider: RampProviderId): string {
  return RAMP_PROVIDER_OPTIONS.find((option) => option.id === provider)?.title ?? provider;
}

function PoweredByRampProvider({ provider }: { provider: RampProviderId }) {
  const providerLabel = getRampProviderLabel(provider);

  return (
    <div className="flex items-center justify-center gap-2 text-sm text-text-low">
      <span>Powered by</span>
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={24}
        height={24}
        className="size-6 rounded-md object-contain"
      />
      <span className="font-medium text-text-medium">{providerLabel}</span>
    </div>
  );
}

export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const wizard = useOnrampWizard(props);
  const {
    stepIndex,
    currentStep,
    isLastStep,
    canProceed,
    liveWalletsError,
    walletsLoading,
    onrampQuote,
    hostedQuoteLoading,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    handlePrimary,
    handleSecondary,
    handleCounterpartyCreated,
  } = wizard;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              {STEPS.map((step, index) => (
                <div
                  key={step.label}
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-200",
                    index === stepIndex
                      ? "w-4 bg-gray-1400"
                      : index < stepIndex
                        ? "w-1.5 bg-gray-1400"
                        : "w-1.5 bg-border-light"
                  )}
                />
              ))}
            </div>
            <span className="text-xs text-text-extra-low">
              Step {stepIndex + 1} of {STEPS.length}
            </span>
          </div>
          <p className="text-2xl font-medium leading-tight text-text-extra-high">
            {currentStep.title}
          </p>
        </div>

        {liveWalletsError ? (
          <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
            {liveWalletsError}
          </div>
        ) : null}

        <OnrampStepContent wizard={wizard} />

        {stepIndex === 2 && onrampQuote ? (
          <PoweredByRampProvider provider={onrampQuote.provider} />
        ) : null}
      </div>

      <div className="sticky bottom-0 z-10 mx-auto mt-auto flex w-full max-w-3xl flex-col gap-3 pt-4 pb-1 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="h-14 rounded-full text-base"
          onClick={handleSecondary}
        >
          {stepIndex === 0 ? "Cancel" : "Previous"}
        </Button>
        <Button
          type="button"
          className="h-14 rounded-full text-base"
          disabled={hostedQuoteLoading || !canProceed || (stepIndex === 1 && walletsLoading)}
          onClick={() => void handlePrimary()}
        >
          {hostedQuoteLoading ? "Opening..." : isLastStep ? "Done" : "Next"}
        </Button>
      </div>

      <CounterpartyCreateDialog
        open={counterpartyDialogOpen}
        onClose={() => setCounterpartyDialogOpen(false)}
        onCreated={handleCounterpartyCreated}
      />
    </div>
  );
}
