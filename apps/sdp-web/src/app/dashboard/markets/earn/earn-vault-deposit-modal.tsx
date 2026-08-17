"use client";

import { type CustodyWalletSummary, type EarnStrategy, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
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

/**
 * The vault builder reads this same mint's scale from chain before signing.
 * Resolve it from the strategy instead of a wallet balance: balance reads are
 * optional context, while the strategy mint defines what the transaction can
 * encode even when that context is unavailable.
 */
function strategyTokenDecimals(strategy: EarnStrategy, token: string | undefined) {
  for (const mint of strategy.depositMints) {
    const knownToken = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
    if (knownToken && knownToken.symbol.toLowerCase() === token) return knownToken.decimals;
  }
  return undefined;
}

/**
 * Fractional zeroes beyond the mint scale carry no precision and the provider
 * canonicalizes them away. Any non-zero digit below one mint atom must be
 * refused rather than rounded before this money-moving request is submitted.
 */
function fitsMintScale(value: string, decimals: number) {
  const fraction = value.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length <= decimals;
}

function validateVaultAmount(value: string, decimals: number | undefined) {
  if (!/^\d+(\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    return { kind: "invalid-shape", valid: false } as const;
  }
  if (decimals === undefined) {
    return { kind: "unknown-scale", valid: false } as const;
  }
  if (!fitsMintScale(value, decimals)) {
    return { decimals, kind: "over-precision", valid: false } as const;
  }
  return { kind: "valid", valid: true } as const;
}

function vaultDepositOutcome(
  status: EarnVaultDepositResult["status"],
  t: ReturnType<typeof useTranslations>
) {
  switch (status) {
    case "pending":
      return {
        body: t("DashboardEarn.deposit.vaultPendingBody"),
        note: t("DashboardEarn.deposit.vaultSettlingNote"),
        title: t("DashboardEarn.deposit.vaultPendingTitle"),
      };
    case "confirmed":
      return {
        body: t("DashboardEarn.deposit.vaultConfirmedBody"),
        note: t("DashboardEarn.deposit.vaultConfirmedNote"),
        title: t("DashboardEarn.deposit.vaultConfirmedTitle"),
      };
    case "submitted":
      return {
        body: t("DashboardEarn.deposit.vaultDoneBody"),
        note: t("DashboardEarn.deposit.vaultSettlingNote"),
        title: t("DashboardEarn.deposit.vaultDoneTitle"),
      };
    case "failed":
      // Failed responses are converted to the modal's error state before a
      // result is stored. Reaching this branch would violate that invariant.
      throw new Error("Failed vault deposits cannot render as successful outcomes");
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled vault deposit status: ${exhaustive}`);
    }
  }
}

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
  const tokenDecimals = strategyTokenDecimals(strategy, token);
  const walletBalance =
    selectedWallet && token ? walletTokenAmount(selectedWallet, token) : undefined;

  const amountNumber = Number(amount);
  // Fail closed if a modal is ever opened for a strategy whose mint metadata
  // cannot establish the transaction's smallest representable unit.
  const amountValidation = validateVaultAmount(amount, tokenDecimals);
  const amountValid = amountValidation.valid;
  const amountPrecisionError =
    amountValidation.kind === "over-precision"
      ? t("DashboardEarn.deposit.vaultAmountPrecision", {
          decimals: amountValidation.decimals,
        })
      : null;
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
     * These are three different outcomes. `submitted` is signed and broadcast
     * but not settled. `pending` is an ambiguous send whose fate SDP could not
     * establish, where a blind retry can deposit twice. `confirmed` is the
     * terminal on-chain result and must never inherit either unconfirmed claim.
     *
     * None claims the position is visible under Active yet: that tab still
     * reads custodial programs only.
     */
    const outcome = vaultDepositOutcome(result.status, t);

    return (
      <Modal isOpen ariaLabel={outcome.title} onClose={onClose} size="md">
        <div data-modal-focus-panel={focusPanelKey} ref={contentRef}>
          <StepSection focusHeading title={outcome.title}>
            <p className="mb-5 text-sm leading-6 text-secondary">{outcome.body}</p>
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
            <p className="mt-4 text-sm leading-6 text-secondary">{outcome.note}</p>
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
                aria-describedby={
                  amountPrecisionError
                    ? "vault-deposit-balance vault-deposit-amount-error"
                    : "vault-deposit-balance"
                }
                aria-invalid={Boolean(amountPrecisionError)}
                autoComplete="off"
                id="vault-deposit-amount"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
                placeholder="0.00"
                value={amount}
              />
              <p className="text-xs text-tertiary tabular-nums" id="vault-deposit-balance">
                {walletBalance === undefined
                  ? t("DashboardEarn.deposit.vaultBalanceUnknown")
                  : t("DashboardEarn.deposit.vaultBalanceAvailable", {
                      amount: formatTokenQuantity(walletBalance, tokenLabel),
                    })}
              </p>
              {amountPrecisionError ? (
                <p
                  className="text-destructive text-xs"
                  id="vault-deposit-amount-error"
                  role="alert"
                >
                  {amountPrecisionError}
                </p>
              ) : null}
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
