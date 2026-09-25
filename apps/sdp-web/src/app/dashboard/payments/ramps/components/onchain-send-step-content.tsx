"use client";

import { compareDecimalAmounts } from "@sdp/solana/amount";
import { type PaymentsDashboardWallet, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import {
  ArrowUpRightIcon,
  ExternalLinkIcon,
  LandmarkIcon,
  PlusIcon,
  StickyNoteIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import { NewSolanaAddressForm } from "@/app/dashboard/payments/counterparty/new-solana-address-form";
import {
  formatTokenAmount,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { ContactCombobox, type ContactControls } from "./contact-combobox";

/** Whether this project can send privately, for the "Send privately" row; null hides it. */
export interface PrivateSendStatus {
  /** The Private Channels feature is on. */
  enabled: boolean;
  /** The project has an active private channel instance. */
  connected: boolean;
}

export type OnchainSendContactControls = ContactControls;

interface StepProps {
  wizard: OnchainSendWizard;
  counterpartyName: string;
  /** The contact picker at the top of the details step; omitted when the contact is fixed. */
  contact?: OnchainSendContactControls;
  privateSend?: PrivateSendStatus | null;
  /** Switches the payment to a bank payout through a provider. */
  onPayByBank?: () => void;
}

function NoAssetsHint({ walletId, assetCount }: { walletId: string; assetCount: number }) {
  const t = useTranslations();
  if (walletId === "" || assetCount > 0) {
    return null;
  }
  return <p className="text-sm text-error">{t("DashboardPayments.onchainSend.noAssets")}</p>;
}

function DetailRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0 refresh:py-3.5 refresh:first:pt-3.5">
      <span className="flex items-center gap-2.5 text-sm text-tertiary refresh:text-body refresh:text-secondary">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-raised text-secondary refresh:hidden">
          {icon}
        </span>
        {label}
      </span>
      <div className="min-w-0 truncate text-right text-sm font-medium text-primary refresh:text-body refresh:font-normal">
        {value}
      </div>
    </div>
  );
}

function sourceWalletName(wallet: PaymentsDashboardWallet | null): string {
  if (wallet === null) {
    return "—";
  }
  if (wallet.label === null) {
    return wallet.walletId;
  }
  return wallet.label;
}

function DestinationOptions(wizard: OnchainSendWizard) {
  return wizard.cryptoAccounts.map((account) => {
    const destination = typeof account.details.address === "string" ? account.details.address : "";
    const short = shortenAddress(destination);
    return {
      value: account.id,
      label: account.label ? `${account.label} · ${short}` : short,
    };
  });
}

/**
 * The design's "Send privately" row. A transfer from this form cannot be private (the transfer
 * API has no such option; private sends go member to member through Private Channels), so the
 * row never offers a working checkbox: without a connected channel it explains why and links
 * to set one up; with one it points there instead.
 */
function PrivateSendOption({ status }: { status: PrivateSendStatus | null }) {
  const t = useTranslations();
  if (status === null || !status.enabled) {
    return null;
  }
  return (
    <div className="flex items-start gap-3">
      {status.connected ? null : (
        <input
          type="checkbox"
          disabled
          aria-describedby="private-send-reason"
          aria-label={t("DashboardPayments.payForm.sendPrivately")}
          className="mt-0.5 size-4 shrink-0 cursor-not-allowed rounded-control-inner border border-border-strong bg-surface-raised"
        />
      )}
      <div className="min-w-0 space-y-1">
        <p className="text-body text-secondary">{t("DashboardPayments.payForm.sendPrivately")}</p>
        <p id="private-send-reason" className="text-meta text-secondary">
          {status.connected
            ? t("DashboardPayments.payForm.privateChannelConnected")
            : t("DashboardPayments.payForm.noPrivateChannel")}
        </p>
        <Link
          href="/dashboard/integrations/private-channels"
          className="inline-flex items-center gap-1 text-body font-medium text-primary hover:underline"
        >
          {t("DashboardPayments.payForm.openPrivateChannels")}
          <ArrowUpRightIcon className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

/** The contact and the account to pay, with the ways to add an address or pay by bank instead. */
function DestinationFields({
  wizard,
  contact,
  onPayByBank,
}: {
  wizard: OnchainSendWizard;
  contact?: OnchainSendContactControls;
  onPayByBank?: () => void;
}) {
  const t = useTranslations();
  const {
    fields,
    setField,
    accountsLoading,
    counterpartyId,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
  } = wizard;
  const destinationOptions = DestinationOptions(wizard);
  const hasContact = counterpartyId !== "";
  // The new address opens under the destination, as the design does, in place of its button.
  const addingAddress = addAccountOpen && hasContact;
  const payByBank = hasContact ? onPayByBank : undefined;

  return (
    <>
      {contact ? (
        <ContactCombobox
          {...contact}
          value={counterpartyId}
          hint={t("DashboardPayments.payForm.contactHint")}
        />
      ) : null}
      <div className="space-y-3">
        <Combobox
          label={t("DashboardPayments.payForm.destination")}
          value={fields.accountId === "" ? null : fields.accountId}
          onChange={(id) => setField("accountId", id)}
          options={destinationOptions}
          placeholder={
            !hasContact
              ? t("DashboardPayments.payForm.selectContactFirst")
              : destinationOptions.length === 0 && !accountsLoading
                ? t("DashboardPayments.payForm.noDestinations")
                : t("DashboardPayments.payForm.selectDestination")
          }
          searchPlaceholder={t("DashboardPayments.ramps.searchAccounts")}
          isLoading={hasContact && accountsLoading}
          disabled={!hasContact || destinationOptions.length === 0}
        />
        {addingAddress ? (
          <NewSolanaAddressForm
            key={counterpartyId}
            className="mt-4"
            counterpartyId={counterpartyId}
            idPrefix="pay-add"
            onAdded={handleAccountAdded}
            onCancel={() => setAddAccountOpen(false)}
          />
        ) : null}
        {addingAddress && !payByBank ? null : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {addingAddress ? null : (
              <button
                type="button"
                disabled={!hasContact}
                onClick={() => setAddAccountOpen(true)}
                className="inline-flex items-center gap-2 text-body font-medium text-secondary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlusIcon className="size-4" aria-hidden="true" />
                {t("DashboardPayments.payForm.addSolanaAddress")}
              </button>
            )}
            {payByBank ? (
              <button
                type="button"
                onClick={payByBank}
                className="inline-flex items-center gap-2 text-body font-medium text-secondary transition-colors hover:text-primary"
              >
                <LandmarkIcon className="size-4" aria-hidden="true" />
                {t("DashboardPayments.payForm.payByBank")}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/** The wallet the payment leaves from, and why it may not be able to sign. */
function SourceWalletField({ wizard }: { wizard: OnchainSendWizard }) {
  const t = useTranslations();
  const { liveWallets, walletsLoading, fields, selectWallet, sourceWalletHint } = wizard;
  const walletOptions = useMemo(
    () =>
      walletComboboxOptions(liveWallets, t("DashboardPayments.restricted"), {
        disableRestricted: true,
      }),
    [liveWallets, t]
  );
  return (
    <div className="space-y-2">
      <Combobox
        label={t("DashboardPayments.onchainSend.sourceWallet")}
        value={fields.walletId === "" ? null : fields.walletId}
        onChange={selectWallet}
        options={walletOptions}
        placeholder={t("DashboardPayments.onchainSend.selectSourceWallet")}
        searchPlaceholder={t("DashboardPayments.onchainSend.searchWallets")}
        isLoading={walletsLoading}
      />
      <p hidden={!sourceWalletHint} className="text-meta text-warning">
        {sourceWalletHint}
      </p>
    </div>
  );
}

/** The amount, its Max, the token, and the balance the amount is checked against. */
function AmountFields({ wizard }: { wizard: OnchainSendWizard }) {
  const t = useTranslations();
  const locale = useLocale();
  const { assetOptions, availableAmount, selectedAsset, exceedsBalance, fields, setField } = wizard;
  const assetSelectOptions = useMemo(
    () => assetOptions.map((asset) => ({ value: asset.value, label: asset.label })),
    [assetOptions]
  );
  const assetLabel = selectedAsset === null ? fields.asset : selectedAsset.label;
  const canMax = availableAmount !== null && compareDecimalAmounts(availableAmount, "0") > 0;
  return (
    <div className="space-y-2">
      <div className="grid items-end gap-x-4 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,0.9fr)]">
        <div className="flex flex-col gap-2">
          <Label htmlFor="onchain-send-amount">{t("DashboardPayments.onchainSend.amount")}</Label>
          <Input
            id="onchain-send-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={fields.amount}
            onChange={(event) => setField("amount", event.currentTarget.value)}
            placeholder="0.00"
            size="xl"
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mb-1 self-end"
          disabled={!canMax}
          onClick={() => {
            if (availableAmount !== null) setField("amount", availableAmount);
          }}
        >
          {t("DashboardPayments.payForm.max")}
        </Button>
        <Combobox
          label={t("DashboardPayments.payForm.token")}
          value={fields.asset === "" ? null : fields.asset}
          onChange={(value) => setField("asset", value)}
          options={assetSelectOptions}
          placeholder={t("DashboardPayments.onchainSend.selectAsset")}
          searchable={false}
          disabled={fields.walletId === "" || assetSelectOptions.length === 0}
        />
      </div>
      {availableAmount === null ? null : (
        <p className={cn("text-meta", exceedsBalance ? "text-error" : "text-tertiary")}>
          {t("DashboardPayments.payForm.available", {
            amount: formatTokenAmount(availableAmount, locale),
            asset: WELL_KNOWN_TOKEN_BY_MINT.get(assetLabel)?.symbol ?? assetLabel,
          })}
        </p>
      )}
      <NoAssetsHint walletId={fields.walletId} assetCount={assetSelectOptions.length} />
    </div>
  );
}

function MemoField({ wizard }: { wizard: OnchainSendWizard }) {
  const t = useTranslations();
  const { fields, setField } = wizard;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="onchain-send-memo">{t("DashboardPayments.payForm.memo")}</Label>
      <Input
        id="onchain-send-memo"
        value={fields.memo}
        onChange={(event) => setField("memo", event.currentTarget.value)}
        placeholder={t("DashboardPayments.payForm.memoPlaceholder")}
        size="xl"
      />
    </div>
  );
}

function DetailsStep({ wizard, contact, privateSend, onPayByBank }: StepProps) {
  return (
    <div className="space-y-6">
      <DestinationFields wizard={wizard} contact={contact} onPayByBank={onPayByBank} />
      <SourceWalletField wizard={wizard} />
      <AmountFields wizard={wizard} />
      <MemoField wizard={wizard} />
      <PrivateSendOption status={privateSend ?? null} />
    </div>
  );
}

function ReviewSummary({ wizard, counterpartyName }: StepProps) {
  const t = useTranslations();
  const { selectedWallet, destinationAddress, selectedAsset, fields } = wizard;
  const memo = fields.memo.trim();
  return (
    <>
      <div className="flex flex-col items-center gap-0.5 border-b border-border-default pb-4 refresh:items-start refresh:pb-6">
        <p className="text-3xl font-semibold tracking-tight text-primary refresh:text-amount refresh:font-medium">
          {fields.amount === "" ? "0" : fields.amount}{" "}
          {selectedAsset === null ? fields.asset : selectedAsset.label}
        </p>
        <p className="text-sm text-tertiary refresh:text-body refresh:text-secondary">
          {t("DashboardPayments.onchainSend.toCounterparty", {
            counterparty:
              counterpartyName === ""
                ? t("DashboardPayments.onchainSend.counterparty")
                : counterpartyName,
          })}
        </p>
      </div>
      <div className="divide-y divide-border-default">
        <DetailRow
          icon={<UserRoundIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.to")}
          value={counterpartyName === "" ? "—" : counterpartyName}
        />
        <DetailRow
          icon={<WalletIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.destination")}
          value={destinationAddress === null ? "—" : shortenAddress(destinationAddress)}
        />
        <DetailRow
          icon={<WalletIcon className="size-3.5" />}
          label={t("DashboardPayments.onchainSend.sourceWallet")}
          value={sourceWalletName(selectedWallet)}
        />
        {memo === "" ? null : (
          <DetailRow
            icon={<StickyNoteIcon className="size-3.5" />}
            label={t("DashboardPayments.onchainSend.memo")}
            value={memo}
          />
        )}
      </div>
    </>
  );
}

function ReviewStep({ wizard, counterpartyName }: StepProps) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const { transferResult, heldApprovalRequestId } = wizard;
  const summary = (
    <section className="w-full space-y-4 rounded-2xl bg-fill-subtle p-5 refresh:rounded-none refresh:bg-transparent refresh:p-0">
      <ReviewSummary wizard={wizard} counterpartyName={counterpartyName} />
    </section>
  );
  // A finished transfer's outcome is the frame heading (the rail's
  // completionTitle); the step body adds only what that heading does not say.
  if (heldApprovalRequestId !== null) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-sm text-tertiary">
          {t("DashboardPayments.onchainSend.approvalPendingDescription")}
        </p>
        {summary}
        <Button asChild type="button" variant="secondary" className="w-full">
          <Link href={`/dashboard/approvals/${encodeURIComponent(heldApprovalRequestId)}`}>
            {t("DashboardPayments.onchainSend.viewApprovalRequest")}
          </Link>
        </Button>
      </div>
    );
  }
  if (transferResult === null) {
    return summary;
  }
  const signature = transferResult.signature;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-tertiary">
        {signature === null
          ? t("DashboardPayments.onchainSend.transferStatus", { status: transferResult.status })
          : t("DashboardPayments.onchainSend.transferSuccess")}
      </p>
      {summary}
      {signature === null ? null : (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          iconLeft={<ExternalLinkIcon />}
          onClick={() =>
            window.open(explorerTxUrl(signature, cluster), "_blank", "noopener,noreferrer")
          }
        >
          {t("DashboardPayments.onchainSend.viewOnExplorer")}
        </Button>
      )}
    </div>
  );
}

export function OnchainSendStepContent(props: StepProps) {
  const { wizard, counterpartyName } = props;
  switch (wizard.currentStepId) {
    case "DETAILS":
      return <DetailsStep {...props} />;
    case "REVIEW":
      return <ReviewStep wizard={wizard} counterpartyName={counterpartyName} />;
  }
}
