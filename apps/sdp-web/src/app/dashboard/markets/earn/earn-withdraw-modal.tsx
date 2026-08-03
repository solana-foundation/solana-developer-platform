"use client";

import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import { useTranslations } from "@/i18n/provider";
import {
  formatTokenAmount,
  getMockStrategy,
  MOCK_EARN_WALLETS,
  type MockEarnStrategy,
} from "./earn-mock-data";
import {
  type MockEarnPosition,
  useMockEarnPositions,
  withdrawFromMockPosition,
  withdrawFromMockPositionsProportionally,
} from "./earn-mock-positions";

interface EarnWithdrawModalProps {
  position: MockEarnPosition;
  strategy: MockEarnStrategy;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const transactionalUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Scope focus to the portaled Earn dialog and return it to the trigger on close. */
function useEarnModalFocus() {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled])')
        ?.focus();
    });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!dialog?.contains(document.activeElement)) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.getAttribute("aria-hidden") !== "true"
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", trapFocus);
      window.requestAnimationFrame(() => {
        const focusTarget = returnFocus?.isConnected
          ? returnFocus
          : document.querySelector<HTMLElement>("[data-earn-withdraw-focus-fallback]");
        focusTarget?.focus();
      });
    };
  }, []);

  return contentRef;
}

/**
 * Withdraw flow honoring the strategy's liquidity term: instant strategies
 * settle straight back to the funding wallet, delayed strategies show the T+n
 * redemption window up front and park the amount as a pending redemption.
 */
export function EarnWithdrawModal({ position, strategy, onClose }: EarnWithdrawModalProps) {
  const t = useTranslations();
  const contentRef = useEarnModalFocus();
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (submitting) contentRef.current?.focus();
  }, [submitting, contentRef]);

  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0 && amount <= position.amount;
  const delayed = strategy.liquidityTerm === "delayed";
  const intradayPercent = Math.round((strategy.intradayFraction ?? 0) * 100);
  const mixedLiquidity = delayed && intradayPercent > 0;
  const delayDays = strategy.redemptionDelayDays ?? 1;
  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === position.walletId);

  const availableDate = new Date(Date.now() + delayDays * 24 * 60 * 60 * 1000).toLocaleDateString(
    "en-US",
    { month: "short", day: "numeric" }
  );

  const submit = () => {
    if (!amountValid) return;
    setSubmitting(true);
    // Design preview only: a short beat so confirmation feels real.
    window.setTimeout(() => {
      withdrawFromMockPosition(
        position.id,
        amount,
        delayed ? delayDays : null,
        strategy.intradayFraction
      );
      setSubmitting(false);
      onClose();
    }, 650);
  };

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardEarn.withdraw.title")}
      onClose={onClose}
      closeDisabled={submitting}
      size="sm"
    >
      <div ref={contentRef} className="p-5" tabIndex={submitting ? 0 : -1} aria-busy={submitting}>
        <h2 className="text-base font-medium text-primary">{t("DashboardEarn.withdraw.title")}</h2>
        <p className="mt-0.5 text-sm text-secondary">
          {t("DashboardEarn.withdraw.fromStrategy", { strategy: strategy.name })}
        </p>

        <div className="mt-4 space-y-2">
          <Label htmlFor="earn-withdraw-amount">{t("DashboardEarn.withdraw.amountLabel")}</Label>
          <Input
            size="lg"
            id="earn-withdraw-amount"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            placeholder="0.00"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={amountInput}
            aria-invalid={Boolean(amountInput && !amountValid)}
            aria-describedby={
              amountInput && !amountValid
                ? "earn-withdraw-available earn-withdraw-error"
                : "earn-withdraw-available"
            }
            onChange={(event: ChangeEvent<HTMLInputElement>) => setAmountInput(event.target.value)}
            iconRight={
              <button
                type="button"
                onClick={() => setAmountInput(String(position.amount))}
                className="pointer-events-auto text-xs font-medium text-primary"
              >
                {t("DashboardEarn.withdraw.useMax")}
              </button>
            }
          />
          <p id="earn-withdraw-available" className="text-xs text-secondary">
            {t("DashboardEarn.withdraw.available", {
              amount: formatTokenAmount(position.amount, position.tokenMint),
            })}
          </p>
          {amountInput && !amountValid ? (
            <p id="earn-withdraw-error" className="text-xs text-error" role="alert">
              {amount > position.amount
                ? t("DashboardEarn.withdraw.errorExceedsPosition")
                : t("DashboardEarn.withdraw.errorAmountRequired")}
            </p>
          ) : null}
        </div>

        <div className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3">
          <p className="text-xs font-medium text-primary">
            {mixedLiquidity
              ? t("DashboardEarn.withdraw.previewMixedTitle", { pct: intradayPercent })
              : delayed
                ? t("DashboardEarn.withdraw.previewDelayedTitle", { days: delayDays })
                : t("DashboardEarn.withdraw.previewInstantTitle")}
          </p>
          <p className="mt-1 text-xs text-secondary">
            {mixedLiquidity
              ? t("DashboardEarn.withdraw.previewMixed", {
                  pct: intradayPercent,
                  wallet: wallet?.name ?? position.walletId,
                  date: availableDate,
                })
              : delayed
                ? t("DashboardEarn.withdraw.previewDelayed", { date: availableDate })
                : t("DashboardEarn.withdraw.previewInstant", {
                    wallet: wallet?.name ?? position.walletId,
                  })}
          </p>
          {!delayed && strategy.sourceKind === "defi" ? (
            // Full-utilization edge case the doc calls out for instant DeFi
            // redemptions: instant is the norm, not a guarantee.
            <p className="mt-1 text-xs text-tertiary">
              {t("DashboardEarn.withdraw.previewInstantDefiCaveat")}
            </p>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("DashboardEarn.withdraw.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || !amountValid}
            iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {submitting
              ? t("DashboardEarn.withdraw.confirming")
              : t("DashboardEarn.withdraw.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface EarnCuratorWithdrawModalProps {
  curatorId: string;
  curatorName: string;
  onClose: () => void;
}

/**
 * Program-level mock redemption. Stablecoin positions are treated as $1 units
 * and reduced proportionally so the user can act on the curator program while
 * each underlying holding still honors its own liquidity window.
 */
export function EarnCuratorWithdrawModal({
  curatorId,
  curatorName,
  onClose,
}: EarnCuratorWithdrawModalProps) {
  const t = useTranslations();
  const contentRef = useEarnModalFocus();
  const allPositions = useMockEarnPositions();
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submissionFailed, setSubmissionFailed] = useState(false);

  useEffect(() => {
    if (submitting) contentRef.current?.focus();
  }, [submitting, contentRef]);

  const programPositions = useMemo(
    () =>
      allPositions.flatMap((position) => {
        const strategy = getMockStrategy(position.strategyId);
        return strategy?.curator === curatorId ? [{ position, strategy }] : [];
      }),
    [allPositions, curatorId]
  );
  const walletIds = useMemo(
    () => [...new Set(programPositions.map((entry) => entry.position.walletId))],
    [programPositions]
  );
  const [walletId, setWalletId] = useState(walletIds[0] ?? "");

  useEffect(() => {
    if (!walletIds.includes(walletId)) {
      setWalletId(walletIds[0] ?? "");
      setAmountInput("");
    }
  }, [walletId, walletIds]);

  const positions = programPositions.filter((entry) => entry.position.walletId === walletId);
  const wallet = MOCK_EARN_WALLETS.find((candidate) => candidate.id === walletId);

  const available = positions.reduce((total, entry) => total + entry.position.amount, 0);
  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0 && amount <= available;
  const showAmountError = Boolean(amountInput && !amountValid) || submissionFailed;
  const maximumDelayDays = positions.reduce(
    (maximum, entry) =>
      entry.strategy?.liquidityTerm === "delayed"
        ? Math.max(maximum, entry.strategy.redemptionDelayDays ?? 1)
        : maximum,
    0
  );

  const submit = () => {
    if (!amountValid || available <= 0) return;
    setSubmitting(true);
    setSubmissionFailed(false);

    window.setTimeout(() => {
      const withdrawn = withdrawFromMockPositionsProportionally(
        positions.map((entry) => ({
          positionId: entry.position.id,
          redemptionDelayDays:
            entry.strategy.liquidityTerm === "delayed"
              ? (entry.strategy.redemptionDelayDays ?? 1)
              : null,
          intradayFraction: entry.strategy.intradayFraction,
        })),
        amount
      );
      setSubmitting(false);
      if (withdrawn === amount) {
        onClose();
      } else {
        setSubmissionFailed(true);
      }
    }, 650);
  };

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardEarn.withdraw.programTitle", { curator: curatorName })}
      onClose={onClose}
      closeDisabled={submitting}
      size="sm"
    >
      <div ref={contentRef} className="p-5" tabIndex={submitting ? 0 : -1} aria-busy={submitting}>
        <h2 className="text-base font-medium text-primary">
          {t("DashboardEarn.withdraw.programTitle", { curator: curatorName })}
        </h2>
        <p className="mt-0.5 text-sm leading-5 text-secondary">
          {t("DashboardEarn.withdraw.programDescription")}
        </p>

        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-primary">
            {t("DashboardEarn.withdraw.programWalletLabel")}
          </p>
          <Select
            ariaLabel={t("DashboardEarn.withdraw.programWalletLabel")}
            value={walletId}
            disabled={submitting || walletIds.length <= 1}
            onValueChange={(nextWalletId) => {
              if (!nextWalletId) return;
              setWalletId(nextWalletId);
              setAmountInput("");
              setSubmissionFailed(false);
            }}
          >
            {walletIds.map((candidateWalletId) => (
              <SelectItem key={candidateWalletId} value={candidateWalletId}>
                {MOCK_EARN_WALLETS.find((candidate) => candidate.id === candidateWalletId)?.name ??
                  candidateWalletId}
              </SelectItem>
            ))}
          </Select>
          <p className="text-xs leading-5 text-tertiary">
            {t("DashboardEarn.withdraw.programWalletDescription", {
              wallet: wallet?.name ?? walletId,
            })}
          </p>
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="earn-curator-withdraw-amount">
            {t("DashboardEarn.withdraw.programAmountLabel")}
          </Label>
          <Input
            size="lg"
            id="earn-curator-withdraw-amount"
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            placeholder="0.00"
            disabled={submitting || available <= 0}
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={amountInput}
            aria-invalid={showAmountError}
            aria-describedby={
              showAmountError
                ? "earn-curator-withdraw-available earn-curator-withdraw-error"
                : "earn-curator-withdraw-available"
            }
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setAmountInput(event.target.value);
              setSubmissionFailed(false);
            }}
            iconRight={
              <button
                type="button"
                disabled={submitting || available <= 0}
                onClick={() => {
                  setAmountInput(String(available));
                  setSubmissionFailed(false);
                }}
                className="pointer-events-auto text-xs font-medium text-primary"
              >
                {t("DashboardEarn.withdraw.useMax")}
              </button>
            }
          />
          <p id="earn-curator-withdraw-available" className="text-xs text-secondary">
            {t("DashboardEarn.withdraw.programAvailable", {
              amount: transactionalUsdFormatter.format(available),
            })}
          </p>
          {showAmountError ? (
            <p id="earn-curator-withdraw-error" className="text-xs text-error" role="alert">
              {submissionFailed
                ? t("DashboardEarn.withdraw.errorBalanceChanged")
                : amount > available
                  ? t("DashboardEarn.withdraw.errorExceedsProgram")
                  : t("DashboardEarn.withdraw.errorAmountRequired")}
            </p>
          ) : null}
        </div>

        <div className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3">
          <p className="text-xs font-medium text-primary">
            {t("DashboardEarn.withdraw.programRoutingTitle")}
          </p>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {positions.length === 1
              ? t("DashboardEarn.withdraw.programRoutingDescriptionOne")
              : t("DashboardEarn.withdraw.programRoutingDescriptionMany", {
                  count: positions.length,
                })}
          </p>
          <p className="mt-1 text-xs leading-5 text-tertiary">
            {maximumDelayDays > 0
              ? t("DashboardEarn.withdraw.programSettlementDelayed", {
                  days: maximumDelayDays,
                })
              : t("DashboardEarn.withdraw.programSettlementInstant")}
          </p>
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t("DashboardEarn.withdraw.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={submitting || !amountValid}
            iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : undefined}
          >
            {submitting
              ? t("DashboardEarn.withdraw.confirming")
              : t("DashboardEarn.withdraw.confirm")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
