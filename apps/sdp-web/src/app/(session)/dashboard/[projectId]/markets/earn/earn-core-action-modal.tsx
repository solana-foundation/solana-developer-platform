"use client";

import type { EarnStrategy, EarnVaultPosition } from "@sdp/types/earn";
import type { Operation, OperationIntent } from "@sdp/types/operations";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { Select, SelectItem } from "@sdp/ui/select";
import { type FormEvent, useState } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { earnCoreClient, isEarnOperationTerminal, useEarnOperation } from "@/lib/earn-core-data";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useEarnFundingWallets, walletDisplayName } from "./deposit/earn-funding-wallets";
import { isPositiveDecimal } from "./earn-decimal";
import { formatTokenValue, tokenSymbol } from "./earn-format";
import { EARN_TRANSACTION_MODAL_FRAME } from "./earn-modal";

const operationKeys = createIdempotencyKeyStore("sdp:earn:core-actions:v1");

function durableKey(fingerprint: string): string {
  const claim = operationKeys.claim(fingerprint);
  if (!claim.persisted)
    throw new Error(
      "Save access is required to safely retry this action. Enable browser storage and try again."
    );
  return claim.key;
}

type ActionProps = {
  onClose: () => void;
  onUpdated?: (operation: Operation) => void;
} & (
  | { kind: "deposit"; strategy: EarnStrategy }
  | { kind: "withdraw"; position: EarnVaultPosition; intermediate?: boolean }
);

function withdrawalIntent(
  props: Extract<ActionProps, { kind: "withdraw" }>,
  amount: string,
  withdrawAll: boolean,
  unit: "token" | "shares",
  slippageBps: number
): OperationIntent {
  const intermediate = props.intermediate ? props.position.parIntermediate : undefined;
  if (intermediate) {
    return {
      kind: "earn.withdraw",
      positionId: props.position.id,
      amount: {
        kind: "intermediate",
        mint: intermediate.mint,
        value: withdrawAll ? intermediate.withdrawableAmount : amount,
      },
      slippageBps,
    };
  }
  const quantity = withdrawAll
    ? { kind: "all" as const }
    : unit === "shares"
      ? { kind: "shares" as const, value: amount }
      : { kind: "token" as const, mint: props.position.tokenMint, value: amount };
  return { kind: "earn.withdraw", positionId: props.position.id, amount: quantity, slippageBps };
}

/** Preparation reviews terms; only the following explicit action can open custody approval. */
export function EarnCoreActionModal(props: ActionProps) {
  const t = useTranslations();
  const workspace = useOptionalDashboardWorkspace();
  const { wallets } = useEarnFundingWallets();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [mint, setMint] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [withdrawAll, setWithdrawAll] = useState(false);
  const [withdrawUnit, setWithdrawUnit] = useState<"token" | "shares">("token");
  const [slippage, setSlippage] = useState("50");
  const [prepared, setPrepared] = useState<Operation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const focusRef = useModalFocus({
    focusKey: prepared?.id ?? "details",
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-strategy-id",
    fallbackValue: props.kind === "deposit" ? props.strategy.id : props.position.id,
  });
  const eligibleWallets = wallets?.filter((wallet) => wallet.isRuntimeExecutionAllowed) ?? [];
  const selectedWallet = walletId ?? eligibleWallets[0]?.id;
  const tokenMint =
    props.kind === "deposit"
      ? (mint ?? props.strategy.depositMints[0])
      : props.intermediate
        ? props.position.parIntermediate?.mint
        : props.position.tokenMint;
  const title =
    props.kind === "deposit" ? t("DashboardEarn.core.deposit") : t("DashboardEarn.core.withdraw");
  const strategyName = props.kind === "deposit" ? props.strategy.name : props.position.label;

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy || !tokenMint) return;
    setError(undefined);
    if (!withdrawAll && !isPositiveDecimal(amount)) {
      setError(t("DashboardEarn.core.positiveAmount"));
      return;
    }
    const slippageBps = Number(slippage);
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1_000) {
      setError(t("DashboardEarn.core.invalidSlippage"));
      return;
    }
    let intent: OperationIntent;
    if (props.kind === "deposit") {
      if (!selectedWallet || !isPositiveDecimal(amount)) return;
      intent = {
        kind: "earn.deposit",
        strategyId: props.strategy.id,
        source: { walletId: selectedWallet },
        amount: { mint: tokenMint, value: amount },
        slippageBps,
      };
    } else {
      intent = withdrawalIntent(props, amount, withdrawAll, withdrawUnit, slippageBps);
    }
    const fingerprint = JSON.stringify([workspace?.selectedProjectId, "prepare", intent]);
    setBusy(true);
    try {
      const key = durableKey(fingerprint);
      let operation: Operation;
      if (intent.kind === "earn.deposit") {
        const { kind: _, ...body } = intent;
        operation = await earnCoreClient.deposit(body, key);
      } else {
        const { kind: _, ...body } = intent;
        operation = await earnCoreClient.withdraw(body, key);
      }
      operationKeys.release(fingerprint, key);
      setPrepared(operation);
      props.onUpdated?.(operation);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("DashboardEarn.core.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal {...EARN_TRANSACTION_MODAL_FRAME} isOpen ariaLabel={title} onClose={props.onClose}>
      <div ref={focusRef}>
        <h2
          className="text-subheading font-medium text-primary"
          data-modal-focus-target
          tabIndex={-1}
        >
          {title}
        </h2>
        <p className="mt-2 text-body text-secondary">{strategyName}</p>
        {prepared ? (
          <EarnOperationReview
            operation={prepared}
            onUpdated={(operation) => {
              setPrepared(operation);
              props.onUpdated?.(operation);
            }}
          />
        ) : (
          <form className="mt-5 space-y-4" onSubmit={prepare}>
            {props.kind === "deposit" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="earn-core-wallet">{t("DashboardEarn.core.wallet")}</Label>
                  <Select
                    id="earn-core-wallet"
                    value={selectedWallet}
                    onValueChange={setWalletId}
                    placeholder={t("DashboardEarn.core.chooseWallet")}
                  >
                    {eligibleWallets.map((wallet) => (
                      <SelectItem key={wallet.id} value={wallet.id}>
                        {walletDisplayName(wallet, t("DashboardMarkets.treasury.unnamedWallet"))}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="earn-core-token">{t("DashboardEarn.core.asset")}</Label>
                  <Select id="earn-core-token" value={tokenMint} onValueChange={setMint}>
                    {props.strategy.depositMints.map((address) => (
                      <SelectItem key={address} value={address}>
                        {tokenSymbol(address)}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                {!props.intermediate ? (
                  <Select
                    value={withdrawUnit}
                    ariaLabel={t("DashboardEarn.core.amountUnit")}
                    onValueChange={(value) => {
                      if (value === "token" || value === "shares") setWithdrawUnit(value);
                    }}
                  >
                    <SelectItem value="token">{tokenSymbol(tokenMint ?? "")}</SelectItem>
                    <SelectItem value="shares">{t("DashboardEarn.core.shares")}</SelectItem>
                  </Select>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setWithdrawAll((all) => !all)}
                >
                  {withdrawAll
                    ? t("DashboardEarn.core.customAmount")
                    : t("DashboardEarn.core.withdrawAll")}
                </Button>
              </div>
            )}
            {!withdrawAll ? (
              <div className="space-y-2">
                <Label htmlFor="earn-core-amount">{t("DashboardEarn.core.amount")}</Label>
                <Input
                  id="earn-core-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="earn-core-slippage">{t("DashboardEarn.core.slippage")}</Label>
              <Input
                id="earn-core-slippage"
                inputMode="numeric"
                value={slippage}
                onChange={(event) => setSlippage(event.target.value)}
              />
            </div>
            <p className="text-caption text-secondary">{t("DashboardEarn.core.prepareNote")}</p>
            {error ? <Callout variant="danger">{error}</Callout> : null}
            <div className="flex justify-end gap-3 pt-4">
              <Button type="button" variant="secondary" onClick={props.onClose}>
                {t("DashboardEarn.core.close")}
              </Button>
              <Button
                type="submit"
                loading={busy}
                disabled={props.kind === "deposit" && !selectedWallet}
              >
                {t("DashboardEarn.core.review")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}

/** The same review and approval UI resumes an operation recovered after reload. */
export function EarnOperationReview({
  operation: initial,
  onUpdated,
}: {
  operation: Operation;
  onUpdated?: (operation: Operation) => void;
}) {
  const t = useTranslations();
  const {
    operation: observed,
    error: readError,
    refresh,
    update,
  } = useEarnOperation(initial.id, initial, onUpdated);
  const operation = observed ?? initial;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [optionId, setOptionId] = useState<string | null>(null);
  const terminal = isEarnOperationTerminal(operation);
  const nextAction = operation.nextAction;
  const selectedOption = optionId ?? operation.terms.options[0]?.id;
  const expired =
    operation.terms.expiresAt !== null && Date.parse(operation.terms.expiresAt) <= Date.now();

  async function act(action: "execute" | "cancel" | "refresh") {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const fingerprint = JSON.stringify([
        operation.id,
        action,
        operation.actionId,
        operation.version,
        selectedOption,
      ]);
      const key = durableKey(fingerprint);
      const updated =
        action === "execute"
          ? await earnCoreClient.execute(
              operation.id,
              {
                actionId: operation.actionId,
                version: operation.version,
                ...(selectedOption ? { optionId: selectedOption } : {}),
              },
              key
            )
          : action === "cancel"
            ? await earnCoreClient.cancel(operation.id, key)
            : await earnCoreClient.refresh(operation.id, key);
      if (action === "cancel") operationKeys.release(fingerprint, key);
      onUpdated?.(updated);
      await update(updated);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("DashboardEarn.core.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const statusKey = `DashboardEarn.core.status.${operation.status}` as const;
  return (
    <div className="mt-5 space-y-4" aria-live="polite">
      <p className="text-body font-medium text-primary">{t(statusKey)}</p>
      {operation.terms.description ? (
        <p className="text-body text-secondary">{operation.terms.description}</p>
      ) : null}
      <EarnOperationTerms operation={operation} />
      {operation.terms.options.length > 1 && !terminal ? (
        <div className="space-y-2">
          <Label htmlFor={`earn-option-${operation.id}`}>{t("DashboardEarn.core.route")}</Label>
          <Select
            id={`earn-option-${operation.id}`}
            value={selectedOption}
            onValueChange={setOptionId}
          >
            {operation.terms.options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      ) : null}
      {nextAction?.type === "approve_in_provider" ? (
        <Callout variant="info">
          <p>{nextAction.instructions}</p>
          {nextAction.handoffUrl && new URL(nextAction.handoffUrl).protocol === "https:" ? (
            <a
              className="underline"
              href={nextAction.handoffUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("DashboardEarn.core.openProvider", { provider: nextAction.provider })}
            </a>
          ) : null}
        </Callout>
      ) : null}
      {nextAction?.type === "wait" ? (
        <p className="text-body text-secondary">{nextAction.reason}</p>
      ) : null}
      {nextAction?.type === "sign_transaction" ? (
        <Callout variant="info">{t("DashboardEarn.core.externalSignature")}</Callout>
      ) : null}
      {operation.status === "settling" ? (
        <p className="text-caption text-secondary">{t("DashboardEarn.core.settlementNote")}</p>
      ) : null}
      {expired && !terminal ? (
        <Callout variant="warning">{t("DashboardEarn.core.expired")}</Callout>
      ) : null}
      {operation.error ? <Callout variant="danger">{operation.error.message}</Callout> : null}
      {error ? <Callout variant="danger">{error}</Callout> : null}
      {readError ? (
        <Callout variant="warning">{t("DashboardEarn.core.refreshFailed")}</Callout>
      ) : null}
      {!terminal ? (
        <div className="flex flex-wrap justify-end gap-3 pt-4">
          <Button variant="secondary" loading={busy} onClick={() => void act("cancel")}>
            {t("DashboardEarn.core.cancel")}
          </Button>
          {(operation.status === "prepared" && nextAction?.type === "execute") ||
          nextAction?.type === "refresh" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void act("refresh")}>
              {t("DashboardEarn.core.refreshTerms")}
            </Button>
          ) : null}
          {nextAction?.type === "execute" ? (
            <Button loading={busy} disabled={expired} onClick={() => void act("execute")}>
              {t("DashboardEarn.core.execute")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EarnOperationTerms({ operation }: { operation: Operation }) {
  const t = useTranslations();
  const locale = useLocale();
  const requestedAmount = operation.terms.inputAmount
    ? formatTokenValue(operation.terms.inputAmount.value, operation.terms.inputAmount.mint, locale)
    : operation.intent.kind === "earn.deposit"
      ? formatTokenValue(operation.intent.amount.value, operation.intent.amount.mint, locale)
      : operation.intent.amount.kind === "all"
        ? t("DashboardEarn.core.allHoldings")
        : operation.intent.amount.kind === "shares"
          ? `${operation.intent.amount.value} ${t("DashboardEarn.core.shares")}`
          : formatTokenValue(operation.intent.amount.value, operation.intent.amount.mint, locale);
  return (
    <DetailList variant="summary">
      <DetailRow
        label={t(
          operation.terms.inputAmount
            ? "DashboardEarn.core.stepInput"
            : "DashboardEarn.core.requested"
        )}
      >
        {requestedAmount}
      </DetailRow>
      {operation.terms.estimate ? (
        <DetailRow label={t("DashboardEarn.core.estimate")}>
          {formatTokenValue(operation.terms.estimate.value, operation.terms.estimate.mint, locale)}
        </DetailRow>
      ) : null}
      {operation.terms.minimum ? (
        <DetailRow label={t("DashboardEarn.core.minimum")}>
          {formatTokenValue(operation.terms.minimum.value, operation.terms.minimum.mint, locale)}
        </DetailRow>
      ) : null}
      <DetailRow label={t("DashboardEarn.core.fees")}>
        {operation.terms.fees === null
          ? t("DashboardEarn.core.unknownFees")
          : operation.terms.fees.length === 0
            ? t("DashboardEarn.core.noFees")
            : operation.terms.fees
                .map((fee) => formatTokenValue(fee.value, fee.mint, locale))
                .join(", ")}
      </DetailRow>
    </DetailList>
  );
}
