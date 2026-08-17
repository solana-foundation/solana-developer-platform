"use client";

import type { CustodyWalletSummary, EarnStrategy } from "@sdp/types";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useModalFocus } from "@/lib/use-modal-focus";
import { StepNotice, StepSection, SummaryRow } from "./deposit/earn-deposit-chrome";
import {
  shortenAddress,
  useEarnFundingWallets,
  walletDisplayName,
  walletTokenAmount,
} from "./deposit/earn-funding-wallets";
import { WalletStep } from "./deposit/wallet-step";
import { formatTokenQuantity } from "./earn-format";
import { createEarnVaultDeposit, type EarnVaultDepositResult } from "./earn-program-data";
import { strategySourceLabel, strategyToken } from "./earn-program-presentation";

/**
 * Deposit into a NON-CUSTODIAL vault: wallet → amount → confirm, in a modal.
 *
 * A MODAL, not a page, and that is deliberate symmetry: `EarnWithdrawModal` is
 * the money-OUT verb for the same position and is already a modal. Two halves of
 * one position behaving differently is a difference a user cannot explain. The
 * full-page wizard next door earns its shape because the CUSTODIAL run is a
 * three-step provisioning flow that ends by creating a program; this is two short
 * steps against a strategy the reader already chose by clicking its row, so
 * navigating away from Opportunities would cost them their place for nothing.
 *
 * Three shapes make this different from that wizard, and all three are why it is
 * a separate component rather than a fourth branch in it:
 *
 * - **The strategy is already chosen.** The reader arrives from an Opportunities
 *   row, so there is no strategy step — picking one again would be asking a
 *   question they just answered.
 * - **Confirm MOVES MONEY.** The custodial run provisions a wallet and hands
 *   back an address to fund later; this signs and submits on the spot. The
 *   review copy has to say so plainly, and the button is the point of no return.
 * - **There is no address, ever.** A K-Vault's account is a program account and
 *   funds sent to it are destroyed, so nothing here may render a "send to"
 *   target — the reason `vault_direct` exists as a distinct deposit style.
 */

type VaultDepositStep = "wallet" | "amount";

export function EarnVaultDepositModal({
  strategy,
  fireblocksEnabled = false,
  onClose,
  onDeposited,
}: {
  strategy: EarnStrategy;
  /**
   * Whether this organization actually has Fireblocks available, threaded from
   * the same provider-availability read the custodial wizard uses. Defaulted
   * false only so the prop is additive; the workspace passes the real value.
   */
  fireblocksEnabled?: boolean;
  onClose: () => void;
  onDeposited?: (result: EarnVaultDepositResult) => void;
}) {
  const t = useTranslations();
  const { wallets, error: walletsError, isLoading: walletsLoading } = useEarnFundingWallets();
  const [step, setStep] = useState<VaultDepositStep>("wallet");
  const [walletRowId, setWalletRowId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EarnVaultDepositResult | null>(null);
  /**
   * Trap/return live for the modal's whole lifetime; autofocus keys off the
   * visible panel so replacing a focused Continue/Submit button cannot drop a
   * keyboard reader onto the page behind the dialog.
   */
  const focusPanelKey = result ? `result:${result.status}` : step;
  const contentRef = useModalFocus<HTMLDivElement>(strategy.id, focusPanelKey);

  /**
   * One idempotency key per (wallet, amount) attempt, held in a ref.
   *
   * A retry after a failed confirm must replay the SAME key — the chain has no
   * request-id dedupe, so a fresh key on retry is how one deposit becomes two.
   * Changing either input mints a new one, because reusing a key with a
   * different payload is a different request.
   */
  const requestIdRef = useRef<{ key: string; token: string } | null>(null);
  const attemptToken = `${walletRowId ?? ""}:${amount}`;
  const requestIdFor = (token: string) => {
    if (requestIdRef.current?.token !== token) {
      requestIdRef.current = { key: crypto.randomUUID(), token };
    }
    return requestIdRef.current.key;
  };

  const selectedWallet: CustodyWalletSummary | undefined = useMemo(
    () => (wallets ?? []).find((wallet) => wallet.id === walletRowId),
    [wallets, walletRowId]
  );
  const token = strategyToken(strategy);
  const tokenLabel = token?.toUpperCase() ?? "";
  const walletBalance =
    selectedWallet && token ? walletTokenAmount(selectedWallet, token) : undefined;

  const amountNumber = Number(amount);
  const amountValid = /^\d+(\.\d+)?$/.test(amount) && amountNumber > 0;
  // Balance is CONTEXT, not a gate: it comes from a live RPC read that may be
  // unavailable, and the chain is the real authority. An unreadable balance must
  // never block a deposit the wallet can actually fund.
  const overBalance = walletBalance !== undefined && amountNumber > walletBalance;

  async function submit() {
    if (!selectedWallet || !amountValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await createEarnVaultDeposit({
        strategyId: strategy.id,
        // SDP custody row id, not the provider-local id or public key: the API
        // authorizes one exact row, then resolves that row's provider wallet.
        custodyWalletId: selectedWallet.id,
        amount,
        requestId: requestIdFor(attemptToken),
      });
      if (!response.ok) {
        setError(response.error ?? t("DashboardEarn.deposit.vaultSubmitError"));
        return;
      }
      const deposit = response.data.data;
      if (deposit.status === "failed") {
        // The API ledgers a failure and answers 200 — surface the provider's own
        // reason rather than a generic message.
        setError(deposit.failureReason ?? t("DashboardEarn.deposit.vaultSubmitError"));
        return;
      }
      setResult(deposit);
      onDeposited?.(deposit);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("DashboardEarn.deposit.vaultSubmitError")
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    /**
     * `pending` and `submitted` are DIFFERENT outcomes and must not share a
     * screen. `submitted` means signed and broadcast — on the wire, not
     * settled. `pending` means SDP holds a signed transaction whose fate it
     * could not establish (an ambiguous send), which is precisely the state a
     * reader must not be told is finished, and precisely the state where a
     * blind retry can deposit twice.
     *
     * Neither is confirmation, so neither claims a holding: SDP has no
     * confirmer for this path yet, and the Active tab reads custodial programs
     * only, so "you will see it under Active" was false for both.
     */
    const inFlight = result.status === "pending";
    const title = inFlight
      ? t("DashboardEarn.deposit.vaultPendingTitle")
      : t("DashboardEarn.deposit.vaultDoneTitle");

    return (
      <Modal isOpen ariaLabel={title} onClose={onClose} size="md">
        <div data-modal-focus-panel={focusPanelKey} ref={contentRef}>
          <StepSection focusHeading title={title}>
            <p className="mb-5 text-sm leading-6 text-secondary">
              {inFlight
                ? t("DashboardEarn.deposit.vaultPendingBody")
                : t("DashboardEarn.deposit.vaultDoneBody")}
            </p>
            <dl className="grid gap-3 rounded-xl border border-border-default bg-surface-raised p-5">
              <SummaryRow label={t("DashboardEarn.deposit.vaultStrategy")} value={strategy.name} />
              <SummaryRow
                label={t("DashboardEarn.deposit.vaultAmount", { token: tokenLabel })}
                value={`${amount} ${token?.toUpperCase() ?? ""}`}
              />
              <SummaryRow
                label={t("DashboardEarn.deposit.vaultFrom")}
                value={walletDisplayName(selectedWallet, selectedWallet?.publicKey ?? "")}
              />
              {/* Keyed off the STRATEGY's cluster, not an app-wide one: the
                transaction landed on whichever cluster the vault lives on, and
                `hostCluster` is the field that states it. A devnet signature on
                a mainnet explorer link is a dead end. */}
              <SummaryRow
                label={t("DashboardEarn.deposit.vaultTransaction")}
                value={
                  <a
                    className="underline underline-offset-2"
                    href={explorerTxUrl(result.signature, strategy.hostCluster)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {shortenAddress(result.signature)}
                  </a>
                }
              />
            </dl>
            <p className="mt-4 text-sm leading-6 text-secondary">
              {t("DashboardEarn.deposit.vaultSettlingNote")}
            </p>
            <div className="mt-6 flex justify-end">
              <Button onClick={onClose}>{t("DashboardEarn.deposit.vaultDone")}</Button>
            </div>
          </StepSection>
        </div>
      </Modal>
    );
  }

  if (step === "wallet") {
    return (
      <Modal
        isOpen
        ariaLabel={t("DashboardEarn.deposit.vaultWalletTitle")}
        onClose={onClose}
        size="md"
      >
        <div data-modal-focus-panel={focusPanelKey} ref={contentRef}>
          <StepSection focusHeading title={t("DashboardEarn.deposit.vaultWalletTitle")}>
            <p className="mb-5 text-sm leading-6 text-secondary">
              {t("DashboardEarn.deposit.vaultWalletBody")}
            </p>
            <WalletStep
              balanceToken={token}
              // Says what this flow actually does, instead of the custodial
              // note's promise of a provider-managed deposit address — which
              // directly contradicted the body immediately above.
              depositMode="vault_direct"
              // Real availability, not a hard-coded `false`. Telling an entitled
              // organization that Fireblocks is unavailable is a wrong statement
              // about their own account, and it was only ever `false` here
              // because this modal had nowhere to read it from.
              fireblocksEnabled={fireblocksEnabled}
              hasError={Boolean(walletsError)}
              isLoading={walletsLoading}
              onSelect={setWalletRowId}
              selectedWalletId={walletRowId}
              wallets={wallets ?? []}
            />
            <div className="mt-6 flex justify-end">
              <Button disabled={!walletRowId} onClick={() => setStep("amount")}>
                {t("DashboardEarn.deposit.continueAction")}
              </Button>
            </div>
          </StepSection>
        </div>
      </Modal>
    );
  }

  return (
    // `closeDisabled` while submitting: the transaction is already signed and in
    // flight, so dismissing here would hide an outcome the reader needs.
    <Modal
      isOpen
      ariaLabel={t("DashboardEarn.deposit.vaultAmountTitle")}
      closeDisabled={submitting}
      onClose={onClose}
      size="md"
    >
      <div data-modal-focus-panel={focusPanelKey} ref={contentRef}>
        <StepSection focusHeading title={t("DashboardEarn.deposit.vaultAmountTitle")}>
          <p className="mb-5 text-sm leading-6 text-secondary">
            {t("DashboardEarn.deposit.vaultAmountBody")}
          </p>
          <div className="grid gap-5">
            <div className="grid gap-2">
              <label className="text-sm text-primary" htmlFor="vault-deposit-amount">
                {t("DashboardEarn.deposit.vaultAmount", { token: tokenLabel })}
              </label>
              <Input
                autoComplete="off"
                id="vault-deposit-amount"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                value={amount}
              />
              <p className="text-xs text-tertiary tabular-nums">
                {walletBalance === undefined
                  ? t("DashboardEarn.deposit.vaultBalanceUnknown")
                  : t("DashboardEarn.deposit.vaultBalanceAvailable", {
                      amount: formatTokenQuantity(walletBalance, tokenLabel),
                    })}
              </p>
            </div>

            <dl className="grid gap-3 rounded-xl border border-border-default bg-surface-raised p-5">
              <SummaryRow label={t("DashboardEarn.deposit.vaultStrategy")} value={strategy.name} />
              <SummaryRow
                label={t("DashboardEarn.deposit.vaultBacking")}
                value={strategySourceLabel(strategy)}
              />
              <SummaryRow
                label={t("DashboardEarn.deposit.vaultFrom")}
                value={walletDisplayName(selectedWallet, selectedWallet?.publicKey ?? "")}
              />
            </dl>

            {/* Over-balance is a WARNING, never a block — the balance is a live RPC
            read and the chain decides. Blocking on it would refuse a deposit the
            wallet can fund whenever that read is stale or unavailable. */}
            {overBalance ? (
              <StepNotice>{t("DashboardEarn.deposit.vaultOverBalance")}</StepNotice>
            ) : null}
            {/* `tone="error"` is not decoration: it carries the error palette AND
            `role="alert"`, so a refusal is announced to a screen reader instead
            of sitting silently in the flow. A refused deposit read as helper
            text without it. */}
            {error ? <StepNotice tone="error">{error}</StepNotice> : null}

            <p className="text-sm leading-6 text-secondary">
              {t("DashboardEarn.deposit.vaultConfirmNote")}
            </p>

            <div className="flex justify-between gap-3">
              <Button onClick={() => setStep("wallet")} variant="secondary">
                {t("DashboardEarn.deposit.back")}
              </Button>
              <Button disabled={!amountValid || submitting} onClick={() => void submit()}>
                {submitting
                  ? t("DashboardEarn.deposit.vaultSubmitting")
                  : t("DashboardEarn.deposit.vaultSubmit")}
              </Button>
            </div>
          </div>
        </StepSection>
      </div>
    </Modal>
  );
}
