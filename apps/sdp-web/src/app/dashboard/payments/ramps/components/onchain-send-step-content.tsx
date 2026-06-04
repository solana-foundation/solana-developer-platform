"use client";

import { CheckCircle2Icon, ExternalLink, PlusIcon, WalletIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { AddExternalAccountDialog } from "@/app/dashboard/payments/counterparty/add-external-account-dialog";
import {
  formatCurrencyAmount,
  resolveTotalBalance,
} from "@/app/dashboard/payments/payments-overview.utils";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OnchainSendWizard } from "../hooks/use-onchain-send-wizard";
import { CounterpartyAccountSelector } from "./counterparty-account-selector";

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <p className="text-sm text-text-low">{label}</p>
      <div className="text-right text-sm font-medium text-text-extra-high">{value}</div>
    </div>
  );
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
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
    accountId,
    setAccountId,
    walletId,
    setWalletId,
    asset,
    setAsset,
    amount,
    setAmount,
    memo,
    setMemo,
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
          value={accountId || null}
          onChange={setAccountId}
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
          value={walletId || null}
          onChange={setWalletId}
          options={walletOptions}
          placeholder="Select a source wallet"
          searchPlaceholder="Search wallets"
          icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
          isLoading={walletsLoading}
        />
        <Combobox
          label="Asset"
          value={asset || null}
          onChange={setAsset}
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
            value={amount}
            onChange={(event) => setAmount(event.currentTarget.value)}
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
                ? `Amount exceeds the available ${asset} balance (${availableAmount}).`
                : `Available: ${availableAmount} ${asset}`}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-text-low" htmlFor="onchain-send-memo">
            Memo (optional)
          </Label>
          <Input
            id="onchain-send-memo"
            value={memo}
            onChange={(event) => setMemo(event.currentTarget.value)}
            placeholder="Add a note for this transfer"
            size="xl"
            className="shadow-none ring-0 [&>span:first-child]:border-0 [&>span:first-child]:bg-border-extra-light"
          />
        </div>
      </div>
    );
  }

  if (transferResult) {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-status-success-border bg-status-success-bg p-5">
          <p className="flex items-center gap-2 text-[20px] font-medium text-status-success-text">
            <CheckCircle2Icon className="size-5" /> Transfer submitted
          </p>
          <p className="mt-2 text-sm text-status-success-text">
            {transferResult.signature
              ? "Transaction sent successfully."
              : `Status: ${transferResult.status}`}
          </p>
        </div>
        {transferResult.signature ? (
          <div className="rounded-2xl border border-border-light bg-border-extra-light p-5">
            <p className="text-sm font-medium text-text-extra-high">Signature</p>
            <p className="mt-3 break-all font-mono text-xs text-text-medium">
              {transferResult.signature}
            </p>
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                iconLeft={<ExternalLink />}
                onClick={() =>
                  window.open(getDevnetExplorerUrl(transferResult.signature ?? ""), "_blank")
                }
              >
                View on explorer
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-border-light bg-border-extra-light p-5">
      <div className="divide-y divide-border-extra-light">
        <SummaryRow label="Flow" value="Onchain transfer" />
        <SummaryRow label="To" value={counterpartyName || "—"} />
        <SummaryRow
          label="Destination"
          value={<span className="font-mono text-xs">{shortenAddress(destinationAddress)}</span>}
        />
        <SummaryRow
          label="Source wallet"
          value={selectedWallet?.label ?? selectedWallet?.walletId ?? "—"}
        />
        <SummaryRow label="Asset" value={asset || "—"} />
        <SummaryRow label="Amount" value={amount || "—"} />
        {memo.trim() ? <SummaryRow label="Memo" value={memo.trim()} /> : null}
      </div>
    </section>
  );
}
