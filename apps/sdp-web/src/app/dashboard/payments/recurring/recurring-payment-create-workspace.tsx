"use client";

import type { Counterparty, CounterpartyAccount, PaymentsDashboardWallet } from "@sdp/types";
import { CreditCardIcon, PlusIcon, RepeatIcon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR, { preload } from "swr";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import { isSolBalance, shortenAddress } from "../payments-overview.utils";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
  fetchWallets,
} from "../payments-workspace.data";
import { CounterpartyPicker } from "../ramps/components/counterparty-picker";
import { RampWizardShell } from "../ramps/components/ramp-wizard-shell";
import {
  PAYMENTS_ACTION_WALLETS_KEY,
  usePaymentsActionWallets,
} from "../ramps/hooks/use-payments-action-wallets";
import { walletBalanceAssetOptions } from "../ramps/wallet-options";
import { createRecurringPayment } from "./recurring-payments.data";

interface RecurringPaymentCreateWorkspaceProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  counterpartiesResult: CounterpartiesResult;
}

type StepId = "counterparty" | "destination" | "details" | "review";

type SchedulePreset = "24" | "168" | "720" | "custom";

interface RecurringPaymentCreateFields {
  counterpartyId: string;
  counterpartyAccountId: string;
  walletId: string;
  token: string;
  amount: string;
  schedulePreset: SchedulePreset;
  customPeriodHours: string;
  firstCollectionAt: string;
  metadataUri: string;
}

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];

const CREATE_STEPS = [
  { id: "counterparty", label: "Counterparty", title: "Who is this recurring payment for?" },
  { id: "destination", label: "Destination", title: "Where should payments go?" },
  { id: "details", label: "Details", title: "Set payment details" },
  { id: "review", label: "Review", title: "Review recurring payment" },
] as const satisfies readonly { id: StepId; label: string; title: string }[];

const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

const SCHEDULE_PRESETS = [
  { value: "24", label: "Every day", description: "Collect once per day." },
  { value: "168", label: "Every week", description: "Collect once per week." },
  { value: "720", label: "Every 30 days", description: "Collect about once per month." },
  { value: "custom", label: "Custom", description: "Enter an interval in hours." },
] as const satisfies readonly {
  value: SchedulePreset;
  label: string;
  description: string;
}[];

function resolveAccountAddress(account: CounterpartyAccount | null): string {
  if (!account) {
    return "";
  }
  const address = account.details.address;
  return typeof address === "string" ? address : "";
}

function resolvePeriodHours(fields: RecurringPaymentCreateFields): number | null {
  const rawValue =
    fields.schedulePreset === "custom" ? fields.customPeriodHours : fields.schedulePreset;
  if (!/^\d+$/.test(rawValue.trim())) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 && value <= 24 * 365 ? value : null;
}

function resolveScheduleLabel(fields: RecurringPaymentCreateFields): string {
  if (fields.schedulePreset !== "custom") {
    return (
      SCHEDULE_PRESETS.find((preset) => preset.value === fields.schedulePreset)?.label ?? "Not set"
    );
  }
  const periodHours = resolvePeriodHours(fields);
  if (!periodHours) {
    return "Custom interval";
  }
  return periodHours === 1 ? "Every hour" : `Every ${periodHours} hours`;
}

function amountIsValid(value: string): boolean {
  return /^\d+(\.\d{1,9})?$/.test(value.trim()) && Number(value) > 0;
}

function metadataUriIsValid(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.length > 128) {
    return false;
  }
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

function firstCollectionAtIsValid(value: string): boolean {
  if (!value) {
    return true;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function ReviewSummaryCard({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  return (
    <section className="rounded-2xl border border-border-light bg-border-extra-light p-5">
      <div className="divide-y divide-border-extra-light">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
          >
            <p className="text-sm text-text-low">{row.label}</p>
            <div className="min-w-0 text-right text-base font-medium text-text-extra-high">
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FieldHint({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <p className={tone === "error" ? "text-sm text-status-error-text" : "text-sm text-text-low"}>
      {children}
    </p>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This wizard intentionally keeps shared form state in one place while each step remains simple.
export function RecurringPaymentCreateWorkspace({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartiesResult,
}: RecurringPaymentCreateWorkspaceProps) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [destinationAccountDialogOpen, setDestinationAccountDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<RecurringPaymentCreateFields>({
    counterpartyId: "",
    counterpartyAccountId: "",
    walletId: "",
    token: "",
    amount: "",
    schedulePreset: "24",
    customPeriodHours: "",
    firstCollectionAt: "",
    metadataUri: "",
  });

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );
  const liveCounterparties = liveCounterpartiesResult ?? counterpartiesResult;

  const { liveWallets: availableWallets, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    fields.counterpartyId ? ["counterparty-accounts", fields.counterpartyId] : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id),
    { revalidateOnFocus: false }
  );

  const cryptoAccounts = useMemo(
    () =>
      (accounts ?? []).filter(
        (account) =>
          account.accountKind === "crypto_wallet" &&
          account.status === "active" &&
          resolveAccountAddress(account).length > 0
      ),
    [accounts]
  );

  const selectedCounterparty =
    liveCounterparties.data.find((counterparty) => counterparty.id === fields.counterpartyId) ??
    null;
  const activeCounterpartiesResult = useMemo(
    () => ({
      ...liveCounterparties,
      data: liveCounterparties.data.filter((counterparty) => counterparty.status === "active"),
    }),
    [liveCounterparties]
  );
  const selectedAccount =
    cryptoAccounts.find((account) => account.id === fields.counterpartyAccountId) ?? null;
  const selectedWallet =
    availableWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null;

  const assetOptions = useMemo<ComboboxOption[]>(
    () =>
      walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, {
        hideUnresolvedMints: true,
      }),
    [issuedTokenSymbolsByMint, selectedWallet]
  );
  const nonSolBalanceCount =
    selectedWallet?.balances?.filter((balance) => !isSolBalance(balance)).length ?? 0;

  const selectedAsset = assetOptions.find((asset) => asset.value === fields.token) ?? null;
  const selectedAssetBalance = useMemo<WalletBalance | null>(
    () =>
      selectedAsset
        ? (selectedWallet?.balances?.find((balance) => balance.mint === fields.token) ?? null)
        : null,
    [fields.token, selectedAsset, selectedWallet]
  );
  const periodHours = resolvePeriodHours(fields);
  const currentStep = CREATE_STEPS[stepIndex];

  useEffect(() => {
    if (!fields.walletId) {
      return;
    }

    const nextToken = assetOptions.some((asset) => asset.value === fields.token)
      ? fields.token
      : (assetOptions[0]?.value ?? "");

    if (nextToken === fields.token) {
      return;
    }

    setFields((current) => ({ ...current, token: nextToken }));
  }, [assetOptions, fields.token, fields.walletId]);

  const setField = <TKey extends keyof RecurringPaymentCreateFields>(
    key: TKey,
    value: RecurringPaymentCreateFields[TKey]
  ) => {
    setFormError(null);
    setFields((current) => ({ ...current, [key]: value }));
  };

  const selectCounterparty = (counterpartyId: string) => {
    setFields((current) => ({
      ...current,
      counterpartyId,
      counterpartyAccountId: "",
    }));
    setFormError(null);
    if (counterpartyId) {
      void preload(PAYMENTS_ACTION_WALLETS_KEY, () => fetchWallets({ includeBalances: true }));
      void preload(["counterparty-accounts", counterpartyId], () =>
        fetchCounterpartyAccounts(counterpartyId)
      );
    }
  };

  const selectWallet = (walletId: string) => {
    const wallet = availableWallets.find((entry) => entry.walletId === walletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(wallet, issuedTokenSymbolsByMint, {
      hideUnresolvedMints: true,
    });
    setFields((current) => ({
      ...current,
      walletId,
      token: nextAssets.some((asset) => asset.value === current.token)
        ? current.token
        : (nextAssets[0]?.value ?? ""),
    }));
    setFormError(null);
  };

  const handleCounterpartyCreated = (created: Counterparty) => {
    selectCounterparty(created.id);
    void mutateCounterparties(
      (previous) =>
        previous
          ? { ...previous, data: [created, ...previous.data] }
          : { ok: true, data: [created] },
      { revalidate: true }
    );
    setCounterpartyDialogOpen(false);
  };

  const handleDestinationAccountAdded = (account: CounterpartyAccount) => {
    setFields((current) => ({
      ...current,
      counterpartyAccountId: account.id,
    }));
    setFormError(null);
    setDestinationAccountDialogOpen(false);
    void mutateAccounts((previous) => [account, ...(previous ?? [])], { revalidate: true });
  };

  const canProceed = useMemo(() => {
    if (currentStep.id === "counterparty") {
      return Boolean(fields.counterpartyId);
    }
    if (currentStep.id === "destination") {
      return Boolean(fields.counterpartyAccountId && resolveAccountAddress(selectedAccount));
    }
    if (currentStep.id === "details") {
      return Boolean(
        fields.walletId &&
          fields.token &&
          selectedAssetBalance &&
          amountIsValid(fields.amount) &&
          periodHours &&
          firstCollectionAtIsValid(fields.firstCollectionAt) &&
          metadataUriIsValid(fields.metadataUri)
      );
    }
    return true;
  }, [currentStep.id, fields, periodHours, selectedAccount, selectedAssetBalance]);

  const reviewRows = [
    { label: "Counterparty", value: selectedCounterparty?.displayName ?? "Not selected" },
    {
      label: "Destination account",
      value: selectedAccount
        ? (selectedAccount.label ?? shortenAddress(resolveAccountAddress(selectedAccount)))
        : "Not selected",
    },
    {
      label: "Funding wallet",
      value: selectedWallet?.label ?? selectedWallet?.walletId ?? "Not selected",
    },
    { label: "Amount", value: `${fields.amount || "-"} ${selectedAsset?.label ?? ""}`.trim() },
    { label: "Billing interval", value: resolveScheduleLabel(fields) },
    {
      label: "First payment",
      value: fields.firstCollectionAt
        ? new Date(fields.firstCollectionAt).toLocaleString()
        : "After activation",
    },
    { label: "Metadata", value: fields.metadataUri.trim() || "Not set" },
  ];

  const submitRecurringPayment = async () => {
    if (!periodHours || !selectedAccount || !selectedAssetBalance) {
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const toastId = toast.loading("Creating recurring payment.", { position: "bottom-right" });
    try {
      const recurringPayment = await createRecurringPayment({
        sourceWalletId: fields.walletId,
        counterpartyId: fields.counterpartyId,
        counterpartyAccountId: fields.counterpartyAccountId,
        token: selectedAssetBalance.mint,
        amount: fields.amount.trim(),
        periodHours,
        ...(fields.firstCollectionAt
          ? { firstCollectionAt: new Date(fields.firstCollectionAt).toISOString() }
          : {}),
        ...(fields.metadataUri.trim() ? { metadataUri: fields.metadataUri.trim() } : {}),
      });
      toast.success("Recurring payment created.", {
        id: toastId,
        description: "It is pending activation.",
        position: "bottom-right",
      });
      router.push(`/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to create recurring payment.";
      setFormError(message);
      toast.error("Recurring payment was not created.", {
        id: toastId,
        description: message,
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrimary = async () => {
    if (!canProceed || submitting) {
      return;
    }
    if (currentStep.id === "review") {
      await submitRecurringPayment();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting) {
      return;
    }
    if (stepIndex === 0) {
      router.push("/dashboard/payments/recurring");
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return (
    <RampWizardShell
      steps={CREATE_STEPS}
      stepIndex={stepIndex}
      primaryDisabled={!canProceed || submitting}
      primaryLabel={currentStep.id === "review" ? "Create recurring payment" : "Next"}
      secondaryLabel={stepIndex === 0 ? "Cancel" : "Previous"}
      walletsError={liveWalletsError}
      onPrimary={handlePrimary}
      onSecondary={handleSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
      secondaryDisabled={submitting}
    >
      {formError ? (
        <div
          role="alert"
          className="rounded-2xl border border-status-error-border bg-status-error-bg px-4 py-3 text-sm text-status-error-text"
        >
          {formError}
        </div>
      ) : null}

      {currentStep.id === "counterparty" ? (
        <CounterpartyPicker
          mode="send"
          counterpartiesResult={activeCounterpartiesResult}
          value={fields.counterpartyId || null}
          onChange={selectCounterparty}
          onAddClick={() => setCounterpartyDialogOpen(true)}
        />
      ) : null}

      {currentStep.id === "destination" ? (
        <div className="space-y-3">
          <Combobox
            label="Destination account"
            value={fields.counterpartyAccountId || null}
            onChange={(value) => setField("counterpartyAccountId", value)}
            options={cryptoAccounts.map((account) => {
              const address = resolveAccountAddress(account);
              return {
                value: account.id,
                label: account.label ?? shortenAddress(address),
                description: shortenAddress(address),
              };
            })}
            placeholder={
              accountsLoading
                ? "Loading accounts"
                : cryptoAccounts.length === 0
                  ? "No Solana accounts on file"
                  : "Select a destination account"
            }
            searchPlaceholder="Search accounts"
            icon={<WalletIcon />}
            isLoading={accountsLoading}
            disabled={accountsLoading || cryptoAccounts.length === 0}
          />
          {!accountsLoading && cryptoAccounts.length === 0 ? (
            <FieldHint tone="error">
              This counterparty needs an active Solana crypto wallet account before you can create a
              recurring payment.
            </FieldHint>
          ) : null}
          {fields.counterpartyId && !accountsLoading ? (
            <button
              type="button"
              onClick={() => setDestinationAccountDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border-medium px-4 py-4 text-left transition-colors hover:bg-border-extra-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-border-extra-light text-text-extra-high">
                <PlusIcon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text-extra-high">
                  Add Solana address
                </span>
                <span className="block text-sm text-text-low">
                  {cryptoAccounts.length === 0
                    ? `${selectedCounterparty?.displayName ?? "This counterparty"} has no destination wallet on file yet.`
                    : "Attach another destination wallet for this counterparty."}
                </span>
              </span>
            </button>
          ) : null}
          {fields.counterpartyId ? (
            <AddExternalAccountDialog
              isOpen={destinationAccountDialogOpen}
              counterpartyId={fields.counterpartyId}
              onAdded={handleDestinationAccountAdded}
              onClose={() => setDestinationAccountDialogOpen(false)}
            />
          ) : null}
        </div>
      ) : null}

      {currentStep.id === "details" ? (
        <div className="space-y-5">
          <Combobox
            label="Funding wallet"
            value={fields.walletId || null}
            onChange={selectWallet}
            options={availableWallets.map((wallet) => ({
              value: wallet.walletId,
              label: wallet.label ?? wallet.walletId,
              description: shortenAddress(wallet.publicKey),
            }))}
            placeholder="Select a funding wallet"
            searchPlaceholder="Search wallets"
            icon={<WalletIcon />}
            disabled={availableWallets.length === 0}
          />

          <Combobox
            label="Asset"
            value={fields.token || null}
            onChange={(value) => setField("token", value)}
            options={assetOptions}
            placeholder={
              fields.walletId
                ? assetOptions.length === 0
                  ? "No supported token balances"
                  : "Select an asset"
                : "Select a wallet first"
            }
            searchPlaceholder="Search assets"
            icon={<CreditCardIcon />}
            disabled={!fields.walletId || assetOptions.length === 0}
          />
          {fields.walletId && assetOptions.length === 0 ? (
            <FieldHint tone="error">
              {nonSolBalanceCount > 0
                ? "This wallet has token balances, but their symbols could not be resolved yet."
                : "Recurring payments require a token balance. Native SOL is not supported."}
            </FieldHint>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-amount">Amount</Label>
              <Input
                id="recurring-payment-amount"
                inputMode="decimal"
                value={fields.amount}
                onChange={(event) => setField("amount", event.currentTarget.value)}
                placeholder="0.00"
              />
              {fields.amount && !amountIsValid(fields.amount) ? (
                <FieldHint tone="error">Enter an amount greater than zero.</FieldHint>
              ) : null}
            </div>

            <Combobox
              label="Billing interval"
              value={fields.schedulePreset}
              onChange={(value) => setField("schedulePreset", value as SchedulePreset)}
              options={SCHEDULE_PRESETS}
              searchable={false}
              icon={<RepeatIcon />}
              size="lg"
            />
          </div>

          {fields.schedulePreset === "custom" ? (
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-period-hours">Interval in hours</Label>
              <Input
                id="recurring-payment-period-hours"
                inputMode="numeric"
                value={fields.customPeriodHours}
                onChange={(event) => setField("customPeriodHours", event.currentTarget.value)}
                placeholder="24"
              />
              {fields.customPeriodHours && !resolvePeriodHours(fields) ? (
                <FieldHint tone="error">
                  Enter a whole number of hours between 1 and 8760.
                </FieldHint>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recurring-payment-first-collection">First payment</Label>
              <Input
                id="recurring-payment-first-collection"
                type="datetime-local"
                value={fields.firstCollectionAt}
                onChange={(event) => setField("firstCollectionAt", event.currentTarget.value)}
              />
              {fields.firstCollectionAt && !firstCollectionAtIsValid(fields.firstCollectionAt) ? (
                <FieldHint tone="error">Choose a future date and time.</FieldHint>
              ) : (
                <FieldHint>Leave blank to start after activation.</FieldHint>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="recurring-payment-metadata">Metadata URL</Label>
              <Input
                id="recurring-payment-metadata"
                value={fields.metadataUri}
                onChange={(event) => setField("metadataUri", event.currentTarget.value)}
                placeholder="https://example.com/metadata.json"
              />
              {fields.metadataUri && !metadataUriIsValid(fields.metadataUri) ? (
                <FieldHint tone="error">Enter a valid URL under 128 characters.</FieldHint>
              ) : (
                <FieldHint>Optional.</FieldHint>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {currentStep.id === "review" ? (
        <div className="space-y-5">
          <ReviewSummaryCard rows={reviewRows} />
          <div className="rounded-2xl border border-border-light bg-white px-4 py-3 text-sm text-text-medium">
            This creates a pending recurring payment record. Activation is a separate step.
          </div>
        </div>
      ) : null}
    </RampWizardShell>
  );
}
