"use client";

import type { Counterparty, RampProviderId } from "@sdp/types";
import Image from "next/image";
import type { ReactNode } from "react";
import { CounterpartyCreateDialog } from "@/app/dashboard/payments/counterparty/counterparty-create-dialog";
import { Button } from "@/components/ui/button";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { cn } from "@/lib/utils";

export function PoweredByRampProvider({ provider }: { provider: RampProviderId }) {
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

interface RampWizardShellProps {
  steps: readonly { label: string; title: string }[];
  stepIndex: number;
  primaryDisabled: boolean;
  primaryLabel: string;
  walletsError: string | null;
  onPrimary: () => void;
  onSecondary: () => void;
  counterpartyDialogOpen: boolean;
  setCounterpartyDialogOpen: (open: boolean) => void;
  onCounterpartyCreated: (created: Counterparty) => void;
  children: ReactNode;
  footer?: ReactNode;
  footerActions?: ReactNode;
  hidePrimary?: boolean;
}

export function RampWizardShell({
  steps,
  stepIndex,
  primaryDisabled,
  primaryLabel,
  walletsError,
  onPrimary,
  onSecondary,
  counterpartyDialogOpen,
  setCounterpartyDialogOpen,
  onCounterpartyCreated,
  children,
  footer,
  footerActions,
  hidePrimary,
}: RampWizardShellProps) {
  return (
    <div className="mx-auto flex h-[80vh] w-full max-w-5xl flex-col py-6">
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 overflow-y-auto px-1.5">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              {steps.map((step, index) => (
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
              Step {stepIndex + 1} of {steps.length}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-3xl font-medium leading-tight tracking-tight text-text-extra-high">
              {steps[stepIndex]?.title}
            </p>
            {footer}
          </div>
        </div>

        {walletsError ? (
          <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text">
            {walletsError}
          </div>
        ) : null}

        {children}
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 pt-4 pb-1 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="h-14 rounded-full text-base"
          onClick={onSecondary}
        >
          {stepIndex === 0 ? "Cancel" : "Previous"}
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row">
          {footerActions}
          {hidePrimary ? null : (
            <Button
              type="button"
              className="h-14 rounded-full text-base"
              disabled={primaryDisabled}
              onClick={onPrimary}
            >
              {primaryLabel}
            </Button>
          )}
        </div>
      </div>

      <CounterpartyCreateDialog
        open={counterpartyDialogOpen}
        onClose={() => setCounterpartyDialogOpen(false)}
        onCreated={onCounterpartyCreated}
      />
    </div>
  );
}
