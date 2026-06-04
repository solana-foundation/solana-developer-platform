"use client";

import {
  CheckCircle2Icon,
  ExternalLink,
  PlusIcon,
  StickyNoteIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { AddExternalAccountDialog } from "@/app/dashboard/payments/counterparty/add-external-account-dialog";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { CounterpartyAccountSelector } from "./counterparty-account-selector";

function DetailRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <span className="flex items-center gap-2.5 text-sm text-text-low">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-text-medium">
          {icon}
        </span>
        {label}
      </span>
      <div className="min-w-0 truncate text-right text-sm font-medium text-text-extra-high">
        {value}
      </div>
    </div>
  );
}

export function OnchainSendStepContent({
  wizard,
  counterpartyName,
}: {
  wizard: OnchainSendWizard;
  counterpartyName: string;
}) {
  const {
    currentStepId,
    cryptoAccounts,
    accountsLoading,
    liveWallets,
    walletsLoading,
    selectedWallet,
    destinationAddress,
    assetOptions,
    availableAmount,
    exceedsBalance,
    counterpartyId,
    fields,
    setField,
    selectWallet,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
    transferResult,
  } = wizard;

  const walletOptions = useMemo(
    () =>
      liveWallets.map((wallet) => {
        const total = wallet.balances ? resolveTotalBalance(wallet.balances) : null;
        return {
          value: wallet.walletId,
          label: wallet.label ?? wallet.walletId,
          description: total !== null ? formatCurrencyAmount(total) : undefined,
        };
      }),
    [liveWallets]
  );

  if (currentStepId === "DESTINATION") {
    return (
      <div className="space-y-3">
        <CounterpartyAccountSelector
          accounts={cryptoAccounts}
          value={fields.accountId || null}
          onChange={(id) => setField("accountId", id)}
          isLoading={accountsLoading}
        />
        <button
          type="button"
          onClick={() => setAddAccountOpen(true)}
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
                ? `${counterpartyName || "This counterparty"} has no Solana address on file yet.`
                : "Attach another destination address for this counterparty."}
            </span>
          </span>
        </button>
        <AddExternalAccountDialog
          isOpen={addAccountOpen}
          counterpartyId={counterpartyId}
          onAdded={handleAccountAdded}
          onClose={() => setAddAccountOpen(false)}
        />
      </div>
    );
  }

  if (currentStepId === "DETAILS") {
    return (
      <div className="space-y-4">
        <Combobox
          label="Source wallet"
          value={fields.walletId || null}
          onChange={selectWallet}
          options={walletOptions}
          placeholder="Select a source wallet"
          searchPlaceholder="Search wallets"
          icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
          isLoading={walletsLoading}
        />
        <Combobox
          label="Asset"
          value={fields.asset || null}
          onChange={(value) => setField("asset", value)}
          options={assetOptions.map((value) => ({ value, label: value }))}
          placeholder="Select an asset"
          searchable={false}
        />
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-text-low" htmlFor="onchain-send-amount">
            Amount
          </Label>
          <Input
            id="onchain-send-amount"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={fields.amount}
            onChange={(event) => setField("amount", event.currentTarget.value)}
            placeholder="1.0"
            size="xl"
            className="shadow-none ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
          />
          {availableAmount !== null ? (
            <p
              className={
                exceedsBalance ? "text-sm text-status-error-text" : "text-sm text-text-low"
              }
            >
              {exceedsBalance
                ? `Amount exceeds the available ${fields.asset} balance (${availableAmount}).`
                : `Available: ${availableAmount} ${fields.asset}`}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-text-low" htmlFor="onchain-send-memo">
            Memo (optional)
          </Label>
          <Input
            id="onchain-send-memo"
            value={fields.memo}
            onChange={(event) => setField("memo", event.currentTarget.value)}
            placeholder="Add a note for this transfer"
            size="xl"
            className="shadow-none ring-0 [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
          />
        </div>
      </div>
    );
  }

  const detailRows = (
    <div className="divide-y divide-border-light">
      <DetailRow
        icon={<UserRoundIcon className="size-3.5" />}
        label="To"
        value={counterpartyName || "—"}
      />
      <DetailRow
        icon={<WalletIcon className="size-3.5" />}
        label="Destination"
        value={<span className="font-mono text-xs">{shortenAddress(destinationAddress)}</span>}
      />
      <DetailRow
        icon={<WalletIcon className="size-3.5" />}
        label="Source wallet"
        value={selectedWallet?.label ?? selectedWallet?.walletId ?? "—"}
      />
      {fields.memo.trim() ? (
        <DetailRow
          icon={<StickyNoteIcon className="size-3.5" />}
          label="Memo"
          value={fields.memo.trim()}
        />
      ) : null}
    </div>
  );

  const amountHero = (
    <div className="flex flex-col items-center gap-0.5 border-b border-border-light pb-4">
      <p className="text-3xl font-semibold tracking-tight text-text-extra-high">
        {fields.amount || "0"} {fields.asset}
      </p>
      <p className="text-sm text-text-low">to {counterpartyName || "counterparty"}</p>
    </div>
  );

  if (transferResult) {
    return (
      <div className="flex flex-col items-center gap-6">
        <div className="flex size-16 items-center justify-center rounded-full bg-status-success-bg text-status-success-text">
          <CheckCircle2Icon className="size-8" />
        </div>
        <div className="space-y-1 text-center">
          <p className="text-2xl font-medium tracking-tight text-text-extra-high">
            Transfer submitted
          </p>
          <p className="text-sm text-text-low">
            {transferResult.signature
              ? "Your transfer was sent successfully."
              : `Status: ${transferResult.status}`}
          </p>
        </div>
        <section className="w-full space-y-4 rounded-2xl bg-border-extra-light p-5">
          {amountHero}
          {detailRows}
        </section>
        {transferResult.signature ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            iconLeft={<ExternalLink />}
            onClick={() =>
              window.open(getDevnetExplorerUrl(transferResult.signature ?? ""), "_blank")
            }
          >
            View on explorer
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl bg-border-extra-light p-5">
      {amountHero}
      {detailRows}
    </section>
  );
}
