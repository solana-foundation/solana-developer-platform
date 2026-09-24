"use client";

import { compareDecimalAmounts, decimalScale, isDecimalString } from "@sdp/solana/amount";
import {
  type Counterparty,
  type CounterpartyAccount,
  PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS,
  type PaymentRecurringPaymentSchedulePreset,
  type PaymentsDashboardWallet,
} from "@sdp/types";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR, { preload } from "swr";
import { z } from "zod";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import type { BadgeVariant } from "@/components/ui/badge";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import {
  formatCurrencyAmount,
  formatTokenAmount,
  isSolBalance,
  resolveTokenByMint,
  resolveTotalBalance,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
} from "../payments-workspace.data";
import { ContactCombobox } from "../ramps/components/contact-combobox";
import { RampWizardShell } from "../ramps/components/ramp-wizard-shell";
import { usePaymentsActionWallets } from "../ramps/hooks/use-payments-action-wallets";
import { walletBalanceAssetOptions, walletComboboxOptions } from "../ramps/wallet-options";
import { createRecurringPayment } from "./recurring-payments.data";
import { accountAddress, getSchedulePresets, parsePeriodHours } from "./recurring-payments-shared";

interface RecurringPaymentCreateWorkspaceProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartiesResult: CounterpartiesResult;
}

type StepId = "payment" | "when" | "review";

type SchedulePreset = PaymentRecurringPaymentSchedulePreset;

interface RecurringPaymentCreateFields {
  counterpartyId: string;
  counterpartyAccountId: string;
  sourceCustodyWalletId: string;
  token: string;
  amount: string;
  schedulePreset: SchedulePreset;
  customPeriodHours: string;
  firstCollectionAt: string;
}

type WalletBalance = NonNullable<PaymentsDashboardWallet["balances"]>[number];

export function recurringPaymentAssetOptions(
  wallet: PaymentsDashboardWallet | null,
  issuedTokenSymbolsByMint: Record<string, string>,
  t: ReturnType<typeof useTranslations>
): ComboboxOption[] {
  const walletWithoutSol = wallet
    ? { ...wallet, balances: wallet.balances?.filter((balance) => !isSolBalance(balance)) }
    : null;

  return walletBalanceAssetOptions(walletWithoutSol, issuedTokenSymbolsByMint, t, {
    hideUnresolvedMints: true,
  });
}

function resolveScheduleLabel(
  fields: RecurringPaymentCreateFields,
  t: ReturnType<typeof useTranslations>,
  schedulePresets: readonly { value: SchedulePreset; label: string }[]
): string {
  if (fields.schedulePreset !== "custom") {
    return (
      schedulePresets.find((preset) => preset.value === fields.schedulePreset)?.label ??
      t("DashboardPayments.recurring.notSet")
    );
  }
  const periodHours = parsePeriodHours(fields.schedulePreset, fields.customPeriodHours);
  if (!periodHours) {
    return t("DashboardPayments.recurring.customInterval");
  }
  return periodHours === 1
    ? t("DashboardPayments.recurring.everyHour")
    : t("DashboardPayments.recurring.everyHours", { count: periodHours });
}

type AmountValidationError = "format" | "notPositive" | "decimals";

/** Max fractional digits accepted before a selected asset bounds the precision (the on-chain 9-decimal cap). */
const AMOUNT_PATTERN_MAX_DECIMALS = 9;

function amountError(value: string, maxDecimals: number): AmountValidationError | null {
  const trimmed = value.trim();
  if (!isDecimalString(trimmed)) {
    return "format";
  }
  if (decimalScale(trimmed) > maxDecimals) {
    return "decimals";
  }
  return compareDecimalAmounts(trimmed, "0") > 0 ? null : "notPositive";
}

function amountErrorMessage(
  error: AmountValidationError,
  maxDecimals: number,
  t: ReturnType<typeof useTranslations>
): string {
  switch (error) {
    case "decimals":
      return t("DashboardPayments.recurring.invalidAmountDecimals", { decimals: maxDecimals });
    case "notPositive":
      return t("DashboardPayments.recurring.invalidAmount");
    case "format":
      return t("DashboardPayments.recurring.invalidAmountFormat");
    default: {
      const exhaustive: never = error;
      throw new Error(`Unhandled amount error: ${exhaustive}`);
    }
  }
}

function firstCollectionAtIsValid(value: string): boolean {
  if (!value) {
    return true;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

/** The figure as the review shows it: grouped, with at least two decimals ("2,400.00"). */
function formatReviewAmount(amount: string, locale: string): string {
  const trimmed = amount.trim();
  if (!isDecimalString(trimmed)) {
    return trimmed;
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return formatTokenAmount(`${whole}.${fraction.padEnd(2, "0")}`, locale);
}

/** The step's question, 18px under the stepper; the fields follow 32px below. */
function StepHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-subheading font-medium text-primary">{children}</h2>;
}

function FieldHint({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "neutral" | "error" | "warning";
}) {
  const toneClassName = { neutral: "text-tertiary", error: "text-error", warning: "text-warning" };
  return <p className={cn("text-meta", toneClassName[tone])}>{children}</p>;
}

/**
 * One line of the review: a 13px label in a 144px column, then the value at 16px with its
 * detail beside it at 14px. Rows are 44px on a shared rule, as the design draws them.
 */
function ReviewRow({
  label,
  value,
  details,
}: {
  label: string;
  value: string;
  details: readonly string[];
}) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-x-4 py-2.5">
      <dt className="text-meta text-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-field text-primary">{value}</span>
        {details.map((detail) => (
          <span key={detail} className="text-body text-secondary">
            {detail}
          </span>
        ))}
      </dd>
    </div>
  );
}

/**
 * New schedule, in the design's three steps: the payment (contact, source wallet, amount and
 * token), when it happens (how often and the first run), then a review. The API's schedule is
 * an interval in hours from a first collection date with no end, so the design's one-time
 * option, end date and "on the 1st" cadence are not offered; what is shown is what the API
 * will do.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This wizard intentionally keeps shared form state in one place while each step remains simple.
export function RecurringPaymentCreateWorkspace({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  issuedTokensByMint,
  counterpartiesResult,
}: RecurringPaymentCreateWorkspaceProps) {
  const t = useTranslations();
  const locale = useLocale();
  const createSteps = [
    { id: "payment", label: t("DashboardPayments.recurring.paymentStep"), title: "" },
    { id: "when", label: t("DashboardPayments.recurring.whenStep"), title: "" },
    { id: "review", label: t("DashboardPayments.counterparty.review"), title: "" },
  ] as const satisfies readonly { id: StepId; label: string; title: string }[];
  const schedulePresets = useMemo(() => getSchedulePresets(t), [t]);
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [destinationAccountDialogOpen, setDestinationAccountDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fields, setFields] = useState<RecurringPaymentCreateFields>({
    counterpartyId: "",
    counterpartyAccountId: "",
    sourceCustodyWalletId: "",
    token: "",
    amount: "",
    schedulePreset: "24",
    customPeriodHours: "",
    firstCollectionAt: "",
  });

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    paymentsQueryKeys.actionCounterparties(),
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );
  const liveCounterparties =
    liveCounterpartiesResult === undefined ? counterpartiesResult : liveCounterpartiesResult;

  const { liveWallets: availableWallets, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    data: accounts,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR(
    fields.counterpartyId
      ? paymentsQueryKeys.counterpartyAccounts({ counterpartyId: fields.counterpartyId })
      : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );

  const cryptoAccounts = useMemo(
    () =>
      (accounts === undefined ? [] : accounts).filter(
        (account) =>
          account.accountKind === "crypto_wallet" &&
          account.status === "active" &&
          accountAddress(account).length > 0
      ),
    [accounts]
  );

  // The design names only the contact. A contact with one Solana address pays to it; with
  // several, a Destination field asks which; with none, the step says so and offers to add one.
  useEffect(() => {
    if (!fields.counterpartyId || accounts === undefined) {
      return;
    }
    setFields((current) => {
      if (cryptoAccounts.some((account) => account.id === current.counterpartyAccountId)) {
        return current;
      }
      const only = cryptoAccounts.length === 1 ? cryptoAccounts[0].id : "";
      return current.counterpartyAccountId === only
        ? current
        : { ...current, counterpartyAccountId: only };
    });
  }, [accounts, cryptoAccounts, fields.counterpartyId]);

  const foundCounterparty = liveCounterparties.data.find(
    (counterparty) => counterparty.id === fields.counterpartyId
  );
  const selectedCounterparty = foundCounterparty === undefined ? null : foundCounterparty;
  const foundAccount = cryptoAccounts.find(
    (account) => account.id === fields.counterpartyAccountId
  );
  const selectedAccount = foundAccount === undefined ? null : foundAccount;
  const foundWallet = availableWallets.find((wallet) => wallet.id === fields.sourceCustodyWalletId);
  const selectedWallet = foundWallet === undefined ? null : foundWallet;
  const selectedWalletTotal =
    selectedWallet === null ? null : resolveTotalBalance(selectedWallet.balances ?? []);

  const walletOptions = useMemo(
    () => walletComboboxOptions(availableWallets, t("DashboardPayments.restricted")),
    [availableWallets, t]
  );
  const assetOptions = useMemo<ComboboxOption[]>(
    () => recurringPaymentAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const assetSelectOptions = useMemo(
    () =>
      assetOptions.map((asset) => {
        const token = resolveTokenByMint(asset.value, issuedTokensByMint, asset.label);
        let badge: string | undefined;
        let badgeVariant: BadgeVariant | undefined;
        if (token.tokenId !== null) {
          badge = t("Shared.SharedComponents.sdpMintedToken");
          badgeVariant = "outline";
        } else if (!token.isWellKnown) {
          badge = t("Shared.SharedComponents.unknownToken");
        }
        return { value: asset.value, label: token.tokenName, badge, badgeVariant };
      }),
    [assetOptions, issuedTokensByMint, t]
  );
  const nonSolBalanceCount =
    selectedWallet?.balances?.filter((balance) => !isSolBalance(balance)).length ?? 0;

  const foundAsset = assetOptions.find((asset) => asset.value === fields.token);
  const selectedAsset = foundAsset === undefined ? null : foundAsset;
  const selectedAssetBalance = useMemo<WalletBalance | null>(
    () =>
      selectedAsset
        ? (selectedWallet?.balances?.find((balance) => balance.mint === fields.token) ?? null)
        : null,
    [fields.token, selectedAsset, selectedWallet]
  );
  const maxAmountDecimals = selectedAssetBalance
    ? selectedAssetBalance.decimals
    : AMOUNT_PATTERN_MAX_DECIMALS;
  const amountValidationError = amountError(fields.amount, maxAmountDecimals);
  const exceedsBalance =
    isDecimalString(fields.amount) &&
    selectedAssetBalance !== null &&
    compareDecimalAmounts(fields.amount, selectedAssetBalance.uiAmount) > 0;
  const periodHours = parsePeriodHours(fields.schedulePreset, fields.customPeriodHours);
  const currentStep = createSteps[stepIndex];
  const assetSelectPlaceholder = fields.sourceCustodyWalletId
    ? assetOptions.length === 0
      ? t("DashboardPayments.recurring.noTokenBalances")
      : t("DashboardPayments.recurring.selectAsset")
    : t("DashboardPayments.recurring.selectWalletFirst");

  useEffect(() => {
    if (!fields.sourceCustodyWalletId) {
      return;
    }

    const nextToken = assetOptions.some((asset) => asset.value === fields.token)
      ? fields.token
      : (assetOptions[0]?.value ?? "");

    if (nextToken === fields.token) {
      return;
    }

    setFields((current) => ({ ...current, token: nextToken }));
  }, [assetOptions, fields.token, fields.sourceCustodyWalletId]);

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
      void preload(paymentsQueryKeys.counterpartyAccounts({ counterpartyId }), () =>
        fetchCounterpartyAccounts(counterpartyId, t)
      );
    }
  };

  const selectWallet = (sourceCustodyWalletId: string) => {
    const foundWallet = availableWallets.find((entry) => entry.id === sourceCustodyWalletId);
    const wallet = foundWallet === undefined ? null : foundWallet;
    const nextAssets = recurringPaymentAssetOptions(wallet, issuedTokenSymbolsByMint, t);
    setFields((current) => ({
      ...current,
      sourceCustodyWalletId,
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
    if (currentStep.id === "payment") {
      return Boolean(
        fields.counterpartyId &&
          fields.counterpartyAccountId &&
          accountAddress(selectedAccount) &&
          fields.sourceCustodyWalletId &&
          fields.token &&
          selectedAssetBalance &&
          amountValidationError === null
      );
    }
    if (currentStep.id === "when") {
      return Boolean(periodHours && firstCollectionAtIsValid(fields.firstCollectionAt));
    }
    return true;
  }, [
    amountValidationError,
    currentStep.id,
    fields,
    periodHours,
    selectedAccount,
    selectedAssetBalance,
  ]);

  const submitRecurringPayment = async () => {
    if (!periodHours || !selectedAccount || !selectedAssetBalance) {
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const toastId = toast.loading(t("DashboardPayments.recurring.creatingPayment"), {
      position: "bottom-right",
    });
    try {
      const recurringPayment = await createRecurringPayment(
        {
          sourceCustodyWalletId: fields.sourceCustodyWalletId,
          counterpartyId: fields.counterpartyId,
          counterpartyAccountId: fields.counterpartyAccountId,
          token: selectedAssetBalance.mint,
          amount: fields.amount.trim(),
          periodHours,
          ...(fields.firstCollectionAt
            ? { firstCollectionAt: new Date(fields.firstCollectionAt).toISOString() }
            : {}),
        },
        undefined,
        t
      );
      toast.success(t("DashboardPayments.recurring.paymentCreated"), {
        id: toastId,
        description: t("DashboardPayments.recurring.pendingActivationDescription"),
        position: "bottom-right",
      });
      router.push(`/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("DashboardPayments.recurring.unableToCreate");
      setFormError(message);
      toast.error(t("DashboardPayments.recurring.paymentNotCreated"), {
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
    const stepId: StepId = currentStep.id;
    switch (stepId) {
      case "payment":
      case "when":
        setStepIndex((current) => current + 1);
        return;
      case "review":
        await submitRecurringPayment();
        return;
      default: {
        const exhaustive: never = stepId;
        throw new Error(`Unhandled recurring payment step: ${String(exhaustive)}`);
      }
    }
  };

  const exitToSchedules = () => {
    if (!submitting) {
      router.push("/dashboard/payments/recurring");
    }
  };

  const handleSecondary = () => {
    if (submitting) {
      return;
    }
    if (stepIndex === 0) {
      exitToSchedules();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const hasContact = fields.counterpartyId !== "";
  const contactName = selectedCounterparty?.displayName ?? t("DashboardPayments.counterpartyLabel");
  const scheduleLabel = resolveScheduleLabel(fields, t, schedulePresets);
  const assetLabel = selectedAsset?.label ?? fields.token;
  const reviewAmount = `${formatReviewAmount(fields.amount, locale)} ${assetLabel}`.trim();
  const firstRunDetail = fields.firstCollectionAt
    ? t("DashboardPayments.recurring.firstRun", {
        date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(fields.firstCollectionAt)
        ),
      })
    : t("DashboardPayments.recurring.firstRunAfterActivation");
  const walletName = selectedWallet?.label ?? selectedWallet?.walletId ?? "";
  const destinationDetail = selectedAccount
    ? (selectedAccount.label ?? shortenAddress(accountAddress(selectedAccount)))
    : "";

  return (
    <RampWizardShell
      steps={createSteps}
      stepIndex={stepIndex}
      primaryDisabled={!canProceed || submitting}
      primaryLabel={
        currentStep.id === "review"
          ? t("DashboardPayments.recurring.createTheSchedule")
          : t("DashboardPayments.ramps.continue")
      }
      walletsError={liveWalletsError}
      onPrimary={handlePrimary}
      onSecondary={handleSecondary}
      onCancel={exitToSchedules}
      counterpartyDialog={{
        open: counterpartyDialogOpen,
        setOpen: setCounterpartyDialogOpen,
        onCreated: handleCounterpartyCreated,
      }}
      secondaryDisabled={submitting}
    >
      {formError ? (
        <div
          role="alert"
          className="rounded-card border border-error-border bg-error-bg px-4 py-3 text-body text-error"
        >
          {formError}
        </div>
      ) : null}

      {currentStep.id === "payment" ? (
        <div>
          <StepHeading>{t("DashboardPayments.recurring.paymentStepTitle")}</StepHeading>
          <div className="mt-8 space-y-6">
            <div className="space-y-3">
              <ContactCombobox
                counterpartiesResult={liveCounterparties}
                onChange={selectCounterparty}
                value={fields.counterpartyId}
                hint={t("DashboardPayments.payForm.contactHint")}
                footer={(close) => (
                  <button
                    type="button"
                    onClick={() => {
                      close();
                      setCounterpartyDialogOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-body font-medium text-secondary transition-colors hover:bg-[var(--select-item-highlight-bg)] hover:text-primary"
                  >
                    <PlusIcon className="size-4" aria-hidden="true" />
                    {t("DashboardPayments.recurring.newContact")}
                  </button>
                )}
              />
              {hasContact && !accountsLoading && cryptoAccounts.length > 1 ? (
                <Combobox
                  label={t("DashboardPayments.payForm.destination")}
                  value={fields.counterpartyAccountId || null}
                  onChange={(value) => setField("counterpartyAccountId", value)}
                  options={cryptoAccounts.map((account) => {
                    const address = accountAddress(account);
                    return {
                      value: account.id,
                      label: account.label ?? shortenAddress(address),
                      description: shortenAddress(address),
                    };
                  })}
                  placeholder={t("DashboardPayments.payForm.selectDestination")}
                  searchPlaceholder={t("DashboardPayments.ramps.searchAccounts")}
                />
              ) : null}
              {hasContact && !accountsLoading && cryptoAccounts.length === 0 ? (
                <FieldHint tone="error">{t("DashboardPayments.payForm.noDestinations")}</FieldHint>
              ) : null}
              {hasContact ? (
                <button
                  type="button"
                  disabled={accountsLoading}
                  onClick={() => setDestinationAccountDialogOpen(true)}
                  className="inline-flex items-center gap-2 text-body font-medium text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {t("DashboardPayments.payForm.addSolanaAddress")}
                </button>
              ) : null}
              {hasContact ? (
                <AddExternalAccountDialog
                  isOpen={destinationAccountDialogOpen}
                  counterpartyId={fields.counterpartyId}
                  onAdded={handleDestinationAccountAdded}
                  onClose={() => setDestinationAccountDialogOpen(false)}
                />
              ) : null}
            </div>

            <div className="space-y-2">
              <Combobox
                label={t("DashboardPayments.onchainSend.sourceWallet")}
                value={fields.sourceCustodyWalletId || null}
                onChange={selectWallet}
                options={walletOptions}
                placeholder={t("DashboardPayments.onchainSend.selectSourceWallet")}
                searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
                disabled={availableWallets.length === 0}
                trailing={
                  selectedWalletTotal === null ? undefined : (
                    <span className="text-secondary tabular-nums">
                      {formatCurrencyAmount(selectedWalletTotal, locale)}
                    </span>
                  )
                }
              />
              {selectedWallet && selectedWallet.isRuntimeExecutionAllowed !== true ? (
                <FieldHint tone="warning">
                  {t("DashboardPayments.signingUnavailable")}{" "}
                  {t("DashboardPayments.recurring.signingDisabledDraft")}
                </FieldHint>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="recurring-payment-amount">
                    {t("DashboardPayments.recurring.amount")}
                  </Label>
                  <Input
                    id="recurring-payment-amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={fields.amount}
                    onChange={(event) => setField("amount", event.currentTarget.value)}
                    placeholder="0.00"
                    size="xl"
                    maxDecimals={maxAmountDecimals}
                  />
                </div>
                <Combobox
                  label={t("DashboardPayments.payForm.token")}
                  value={fields.token || null}
                  onChange={(value) => setField("token", value)}
                  options={assetSelectOptions}
                  placeholder={assetSelectPlaceholder}
                  searchable={false}
                  disabled={!fields.sourceCustodyWalletId || assetSelectOptions.length === 0}
                  size="xl"
                />
              </div>
              {fields.amount && amountValidationError ? (
                <FieldHint tone="error">
                  {amountErrorMessage(amountValidationError, maxAmountDecimals, t)}
                </FieldHint>
              ) : selectedAssetBalance ? (
                <FieldHint tone={exceedsBalance ? "error" : "neutral"}>
                  {t("DashboardPayments.payForm.available", {
                    amount: formatTokenAmount(selectedAssetBalance.uiAmount, locale),
                    asset: assetLabel,
                  })}
                </FieldHint>
              ) : null}
              {fields.sourceCustodyWalletId && assetOptions.length === 0 ? (
                <FieldHint tone="error">
                  {nonSolBalanceCount > 0
                    ? t("DashboardPayments.recurring.unresolvedTokenBalances")
                    : t("DashboardPayments.recurring.nativeSolUnsupported")}
                </FieldHint>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {currentStep.id === "when" ? (
        <div>
          <StepHeading>{t("DashboardPayments.recurring.whenStepTitle")}</StepHeading>
          <div className="mt-8 space-y-6">
            <Combobox
              label={t("DashboardPayments.recurring.repeats")}
              value={fields.schedulePreset}
              onChange={(value) => {
                const parsed = z.enum(PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS).safeParse(value);
                if (parsed.success) setField("schedulePreset", parsed.data);
              }}
              options={schedulePresets}
              searchable={false}
              size="xl"
            />

            {fields.schedulePreset === "custom" ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="recurring-payment-period-hours">
                  {t("DashboardPayments.recurring.intervalHours")}
                </Label>
                <Input
                  id="recurring-payment-period-hours"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={24 * 365}
                  step="1"
                  value={fields.customPeriodHours}
                  onChange={(event) => setField("customPeriodHours", event.currentTarget.value)}
                  placeholder="24"
                  size="xl"
                />
                {fields.customPeriodHours &&
                !parsePeriodHours(fields.schedulePreset, fields.customPeriodHours) ? (
                  <FieldHint tone="error">
                    {t("DashboardPayments.recurring.invalidInterval")}
                  </FieldHint>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="recurring-payment-first-collection">
                {t("DashboardPayments.recurring.startsOn")}
              </Label>
              <DateTimePicker
                id="recurring-payment-first-collection"
                value={fields.firstCollectionAt}
                onChange={(value) => setField("firstCollectionAt", value)}
                disablePast
                size="xl"
              />
              {fields.firstCollectionAt && !firstCollectionAtIsValid(fields.firstCollectionAt) ? (
                <FieldHint tone="error">
                  {t("DashboardPayments.recurring.invalidFirstPayment")}
                </FieldHint>
              ) : (
                <FieldHint tone="neutral">
                  {t("DashboardPayments.recurring.startAfterActivation")}
                </FieldHint>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {currentStep.id === "review" ? (
        <div>
          <p className="text-quote font-medium tracking-tight">
            <span className="text-primary tabular-nums">
              {formatReviewAmount(fields.amount, locale)}
            </span>{" "}
            <span className="text-secondary">{assetLabel}</span>
          </p>
          <p className="mt-5 text-body text-secondary">
            {t("DashboardPayments.recurring.reviewSentence", {
              contact: contactName,
              schedule: scheduleLabel.toLocaleLowerCase(locale),
            })}
          </p>
          <dl className="mt-6 divide-y divide-border-subtle">
            <ReviewRow
              label={t("DashboardPayments.recurring.pays")}
              value={t("DashboardPayments.recurring.amountToCounterparty", {
                amount: reviewAmount,
                counterparty: contactName,
              })}
              details={[
                t("DashboardPayments.recurring.fromWallet", { wallet: walletName }),
                ...(destinationDetail
                  ? [t("DashboardPayments.recurring.toAccount", { account: destinationDetail })]
                  : []),
              ]}
            />
            <ReviewRow
              label={t("DashboardPayments.recurring.repeats")}
              value={scheduleLabel}
              details={[firstRunDetail]}
            />
            <ReviewRow
              label={t("DashboardPayments.recurring.ends")}
              value={t("DashboardPayments.recurring.noEndDate")}
              details={[t("DashboardPayments.recurring.runsUntilStopped")]}
            />
            <ReviewRow
              label={t("DashboardPayments.recurring.ifRunFails")}
              value={t("DashboardPayments.recurring.staysActive")}
              details={[t("DashboardPayments.recurring.failedRunDetail")]}
            />
          </dl>
          <p className="mt-6 text-body text-secondary">
            {t("DashboardPayments.recurring.pendingRecordDescription")}
          </p>
        </div>
      ) : null}
    </RampWizardShell>
  );
}
