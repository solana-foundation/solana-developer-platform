"use client";

import type { ComplianceProviderId, PaymentsDashboardWallet, RampProviderId } from "@sdp/types";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_RAMP_PAIR,
  findRampPair,
  ONRAMP_PAIRS,
  RAMP_PROVIDER_OPTIONS,
  type SelectedRampPair,
} from "@/lib/ramps";
import { useZodForm } from "@/lib/use-zod-form";
import { cn } from "@/lib/utils";
import { CounterpartyCreateDialog } from "./counterparty/counterparty-create-dialog";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchWallets,
} from "./payments-workspace.data";
import { CounterpartySelector } from "./ramps/components/counterparty-selector";
import { RampPairProviderSelector } from "./ramps/components/ramp-pair-provider-selector";
import {
  counterpartySelectionSchema,
  depositAmountSchema,
  depositSelectionSchema,
  INITIAL_ONRAMP_FIELDS,
} from "./ramps/components/schema";

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

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

const STEPS = [
  { label: "Counterparty", title: "Who is this deposit for?" },
  { label: "Deposit", title: "How much would you like to deposit?" },
  { label: "Step 3", title: "Coming soon" },
  { label: "Step 4", title: "Coming soon" },
] as const;

const STEP_SCHEMAS = [counterpartySelectionSchema, depositAmountSchema, null, null] as const;

export function PaymentsActionPage({
  wallets,
  walletsError,
  enabledRampProviders,
  counterpartiesResult,
}: PaymentsActionPageProps) {
  const router = useRouter();

  const [stepIndex, setStepIndex] = useState(0);
  const [selectedRampPair, setSelectedRampPair] = useState<SelectedRampPair>(DEFAULT_RAMP_PAIR);
  const form = useZodForm(depositSelectionSchema, INITIAL_ONRAMP_FIELDS);
  const { values: onrampFields, setField } = form;

  const { data: swrWallets, error: walletsFetchError } = useSWR<PaymentsDashboardWallet[]>(
    PAYMENTS_ACTION_WALLETS_KEY,
    () => fetchWallets({ includeBalances: true }),
    {
      fallbackData: wallets.length > 0 ? wallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === onrampFields.walletId) ?? null,
    [liveWallets, onrampFields.walletId]
  );

  const stepSchema = STEP_SCHEMAS[stepIndex];
  const canProceed = useMemo(
    () => (stepSchema ? stepSchema.safeParse(onrampFields).success : true),
    [stepSchema, onrampFields]
  );

  const isLastStep = stepIndex === STEPS.length - 1;
  const currentStep = STEPS[stepIndex];

  const handlePrimary = () => {
    if (!canProceed) {
      return;
    }
    if (isLastStep) {
      toast.info("Next step coming soon.");
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (stepIndex === 0) {
      router.push("/dashboard/payments");
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

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

        {stepIndex === 0 ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setCounterpartyDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-light px-4 py-3.5 text-left transition-colors hover:border-border-medium hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
                <PlusIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-extra-high">
                  Add counterparty
                </span>
                <span className="block text-sm text-text-low">
                  Create a new buyer to deposit for if they aren&apos;t in the list yet.
                </span>
              </span>
            </button>
            <CounterpartySelector
              counterpartiesResult={liveCounterpartiesResult}
              value={onrampFields.counterpartyId || null}
              onChange={(id) => setField("counterpartyId", id)}
            />
          </div>
        ) : stepIndex === 1 ? (
          enabledRampProviders.length === 0 ? (
            <div className="rounded-2xl border border-border-light bg-border-extra-light px-5 py-5 text-sm text-text-low">
              No on-ramp providers are enabled for this organization.
            </div>
          ) : (
            <RampPairProviderSelector
              direction="onramp"
              pairs={ONRAMP_PAIRS}
              enabledRampProviders={enabledRampProviders}
              providerOptions={RAMP_PROVIDER_OPTIONS}
              wallets={liveWallets}
              walletsLoading={walletsLoading}
              selectedWallet={selectedWallet}
              selectedPair={selectedRampPair}
              selectedProvider={onrampFields.provider}
              amount={onrampFields.amount}
              onAmountChange={(value) => setField("amount", value)}
              onAmountBlur={() => {}}
              onWalletChange={(walletId) => setField("walletId", walletId)}
              onPairChange={(nextPair) => {
                setSelectedRampPair(nextPair);
                const support = findRampPair(ONRAMP_PAIRS, nextPair);
                if (onrampFields.provider && !support?.providers.includes(onrampFields.provider)) {
                  setField("provider", null);
                }
              }}
              onProviderSelect={(nextProvider) => setField("provider", nextProvider)}
            />
          )
        ) : (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border-light bg-border-extra-light px-6 py-16 text-center">
            <p className="text-lg font-medium text-text-extra-high">Coming soon</p>
            <p className="mt-1 text-sm text-text-low">This step isn&apos;t built yet.</p>
          </div>
        )}
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
          disabled={!canProceed || (stepIndex === 1 && walletsLoading)}
          onClick={handlePrimary}
        >
          {isLastStep ? "Done" : "Next"}
        </Button>
      </div>

      <CounterpartyCreateDialog
        open={counterpartyDialogOpen}
        onClose={() => setCounterpartyDialogOpen(false)}
        onCreated={(created) => {
          setField("counterpartyId", created.id);
          void mutateCounterparties(
            (prev) =>
              prev ? { ...prev, data: [created, ...prev.data] } : { ok: true, data: [created] },
            { revalidate: true }
          );
          setCounterpartyDialogOpen(false);
        }}
      />
    </div>
  );
}
