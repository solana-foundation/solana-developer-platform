"use client";

import { isDecimalString } from "@sdp/solana/amount";
import { PAYMENT_RECURRING_PAYMENT_SCHEDULE_PRESETS } from "@sdp/types";
import { PlusIcon } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { Combobox } from "@/components/ui/combobox";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { AddExternalAccountDialog } from "../counterparty/add-external-account-dialog";
import {
  formatCurrencyAmount,
  formatTokenAmount,
  shortenAddress,
} from "../payments-overview.utils";
import { formatDateTime } from "../payments-presentation";
import { ContactCombobox } from "../ramps/components/contact-combobox";
import { RampWizardShell } from "../ramps/components/ramp-wizard-shell";
import { accountAddress, parsePeriodHours } from "./recurring-payments-shared";
import {
  amountErrorMessage,
  firstCollectionAtIsValid,
  type RecurringPaymentCreateForm,
  type RecurringPaymentCreateInput,
  resolveScheduleLabel,
  useRecurringPaymentCreate,
} from "./use-recurring-payment-create";

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

interface StepProps {
  form: RecurringPaymentCreateForm;
}

/** The contact, and its Solana address when it has more than one (or none). */
function ContactFields({ form }: StepProps) {
  const t = useTranslations();
  const {
    fields,
    setField,
    liveCounterparties,
    selectCounterparty,
    setCounterpartyDialogOpen,
    accountsLoading,
    cryptoAccounts,
    resolvedAccountId,
    destinationAccountDialogOpen,
    setDestinationAccountDialogOpen,
    handleDestinationAccountAdded,
  } = form;
  const hasContact = fields.counterpartyId !== "";
  const accountsKnown = hasContact && !accountsLoading;
  return (
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
      {accountsKnown && cryptoAccounts.length > 1 ? (
        <Combobox
          label={t("DashboardPayments.payForm.destination")}
          value={resolvedAccountId || null}
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
      {accountsKnown && cryptoAccounts.length === 0 ? (
        <FieldHint tone="error">{t("DashboardPayments.payForm.noDestinations")}</FieldHint>
      ) : null}
      {hasContact ? (
        <>
          <button
            type="button"
            disabled={accountsLoading}
            onClick={() => setDestinationAccountDialogOpen(true)}
            className="inline-flex items-center gap-2 text-body font-medium text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("DashboardPayments.payForm.addSolanaAddress")}
          </button>
          <AddExternalAccountDialog
            isOpen={destinationAccountDialogOpen}
            counterpartyId={fields.counterpartyId}
            onAdded={handleDestinationAccountAdded}
            onClose={() => setDestinationAccountDialogOpen(false)}
          />
        </>
      ) : null}
    </div>
  );
}

/** The source wallet, with its total beside it and a note when it cannot sign. */
function SourceWalletField({ form }: StepProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { fields, selectWallet, walletOptions, availableWallets, selectedWallet } = form;
  const total = form.selectedWalletTotal;
  return (
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
          total === null ? undefined : (
            <span className="text-secondary tabular-nums">
              {formatCurrencyAmount(total, locale)}
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
  );
}

/** The amount beside its token, then the balance it is checked against (or why there is none). */
function AmountFields({ form }: StepProps) {
  const t = useTranslations();
  const locale = useLocale();
  const {
    fields,
    setField,
    maxAmountDecimals,
    assetSelectOptions,
    assetSelectPlaceholder,
    resolvedToken,
    selectedAsset,
    selectedAssetBalance,
    amountValidationError,
    exceedsBalance,
    assetOptions,
    nonSolBalanceCount,
  } = form;
  const assetLabel = selectedAsset?.label ?? resolvedToken;
  return (
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
          value={resolvedToken || null}
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
  );
}

function PaymentStep({ form }: StepProps) {
  const t = useTranslations();
  return (
    <div>
      <StepHeading>{t("DashboardPayments.recurring.paymentStepTitle")}</StepHeading>
      <div className="mt-8 space-y-6">
        <ContactFields form={form} />
        <SourceWalletField form={form} />
        <AmountFields form={form} />
      </div>
    </div>
  );
}

function WhenStep({ form }: StepProps) {
  const t = useTranslations();
  const { fields, setField, schedulePresets } = form;
  return (
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
              <FieldHint tone="error">{t("DashboardPayments.recurring.invalidInterval")}</FieldHint>
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
  );
}

function ReviewStep({ form }: StepProps) {
  const t = useTranslations();
  const locale = useLocale();
  const {
    fields,
    schedulePresets,
    selectedCounterparty,
    selectedAsset,
    resolvedToken,
    selectedWallet,
    selectedAccount,
  } = form;
  const contactName = selectedCounterparty?.displayName ?? t("DashboardPayments.counterpartyLabel");
  const scheduleLabel = resolveScheduleLabel(fields, t, schedulePresets);
  const assetLabel = selectedAsset?.label ?? resolvedToken;
  const reviewAmount = `${formatReviewAmount(fields.amount, locale)} ${assetLabel}`.trim();
  // The first run is typed on the When step in the browser, so it is never formatted on the
  // server; the shared formatter keeps it in the list's "Aug 5, 2026, 2:30 PM" form.
  const firstRunDate = formatDateTime(fields.firstCollectionAt || null, locale);
  const firstRunDetail = firstRunDate
    ? t("DashboardPayments.recurring.firstRun", { date: firstRunDate })
    : t("DashboardPayments.recurring.firstRunAfterActivation");
  const walletName = selectedWallet?.label ?? selectedWallet?.walletId ?? "";
  const destinationDetail = selectedAccount
    ? (selectedAccount.label ?? shortenAddress(accountAddress(selectedAccount)))
    : "";
  return (
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
  );
}

/**
 * New schedule, in the design's three steps: the payment (contact, source wallet, amount and
 * token), when it happens (how often and the first run), then a review. The API's schedule is
 * an interval in hours from a first collection date with no end, so the design's one-time
 * option, end date and "on the 1st" cadence are not offered; what is shown is what the API
 * will do. The state lives in {@link useRecurringPaymentCreate}; this wires it to the frame.
 */
export function RecurringPaymentCreateWorkspace(props: RecurringPaymentCreateInput) {
  const t = useTranslations();
  const form = useRecurringPaymentCreate(props);
  const { currentStep } = form;

  return (
    <RampWizardShell
      steps={form.steps}
      stepIndex={form.stepIndex}
      primaryDisabled={!form.canProceed || form.submitting}
      primaryLabel={
        currentStep.id === "review"
          ? t("DashboardPayments.recurring.createTheSchedule")
          : t("DashboardPayments.ramps.continue")
      }
      walletsError={form.liveWalletsError}
      onPrimary={() => void form.handlePrimary()}
      onSecondary={form.handleSecondary}
      onCancel={form.exitToSchedules}
      counterpartyDialog={{
        open: form.counterpartyDialogOpen,
        setOpen: form.setCounterpartyDialogOpen,
        onCreated: form.handleCounterpartyCreated,
      }}
      secondaryDisabled={form.submitting}
    >
      {form.formError ? (
        <div
          role="alert"
          className="rounded-card border border-error-border bg-error-bg px-4 py-3 text-body text-error"
        >
          {form.formError}
        </div>
      ) : null}
      {currentStep.id === "payment" ? <PaymentStep form={form} /> : null}
      {currentStep.id === "when" ? <WhenStep form={form} /> : null}
      {currentStep.id === "review" ? <ReviewStep form={form} /> : null}
    </RampWizardShell>
  );
}
