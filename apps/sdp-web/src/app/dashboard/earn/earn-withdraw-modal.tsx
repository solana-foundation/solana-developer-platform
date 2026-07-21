"use client";

import { Loader2Icon } from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { formatTokenAmount, MOCK_EARN_WALLETS, type MockEarnStrategy } from "./earn-mock-data";
import { type MockEarnPosition, withdrawFromMockPosition } from "./earn-mock-positions";

interface EarnWithdrawModalProps {
  position: MockEarnPosition;
  strategy: MockEarnStrategy;
  onClose: () => void;
}

/**
 * Withdraw flow honoring the strategy's liquidity term: instant strategies
 * settle straight back to the funding wallet, delayed strategies show the T+n
 * redemption window up front and park the amount as a pending redemption.
 */
export function EarnWithdrawModal({ position, strategy, onClose }: EarnWithdrawModalProps) {
  const t = useTranslations();
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const amount = Number(amountInput);
  const amountValid = Number.isFinite(amount) && amount > 0 && amount <= position.amount;
  const delayed = strategy.liquidityTerm === "delayed";
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
      withdrawFromMockPosition(position.id, amount, delayed ? delayDays : null);
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
      <div className="p-5">
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
          <p className="text-xs text-secondary">
            {t("DashboardEarn.withdraw.available", {
              amount: formatTokenAmount(position.amount, position.tokenMint),
            })}
          </p>
          {amountInput && !amountValid ? (
            <p className="text-xs text-error">
              {amount > position.amount
                ? t("DashboardEarn.withdraw.errorExceedsPosition")
                : t("DashboardEarn.withdraw.errorAmountRequired")}
            </p>
          ) : null}
        </div>

        <div className="mt-4 rounded-md border border-border-default bg-fill-subtle p-3">
          <p className="text-xs font-medium text-primary">
            {delayed
              ? t("DashboardEarn.withdraw.previewDelayedTitle", { days: delayDays })
              : t("DashboardEarn.withdraw.previewInstantTitle")}
          </p>
          <p className="mt-1 text-xs text-secondary">
            {delayed
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
