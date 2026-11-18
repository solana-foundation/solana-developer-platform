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

function useEarnPreparation(props: ActionProps) {
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
  const eligibleWallets = wallets?.filter((wallet) => wallet.isRuntimeExecutionAllowed) ?? [];
  const selectedWallet = walletId ?? eligibleWallets[0]?.id;
  const tokenMint =
    props.kind === "deposit"
      ? (mint ?? props.strategy.depositMints[0])
      : props.intermediate
        ? props.position.parIntermediate?.mint
        : props.position.tokenMint;
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

  return {
    eligibleWallets,
    selectedWallet,
    tokenMint,
    setWalletId,
    setMint,
    amount,
    setAmount,
    withdrawAll,
    setWithdrawAll,
    withdrawUnit,
    setWithdrawUnit,
    slippage,
    setSlippage,
    prepared,
    setPrepared,
    busy,
    error,
    prepare,
  };
}

/** Preparation reviews terms; only the following explicit action can open custody approval. */
export function EarnCoreActionModal(props: ActionProps) {
  const t = useTranslations();
  const preparation = useEarnPreparation(props);
  const {
    selectedWallet,
    amount,
    setAmount,
    withdrawAll,
    slippage,
    setSlippage,
    prepared,
    setPrepared,
    busy,
    error,
    prepare,
  } = preparation;
  const focusRef = useModalFocus({
    focusKey: prepared?.id ?? "details",
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-strategy-id",
    fallbackValue: props.kind === "deposit" ? props.strategy.id : props.position.id,
  });
  const title =
    props.kind === "deposit" ? t("DashboardEarn.core.deposit") : t("DashboardEarn.core.withdraw");
  const strategyName = props.kind === "deposit" ? props.strategy.name : props.position.label;

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
              <EarnFundingSourceFields strategy={props.strategy} preparation={preparation} />
            ) : (
              <EarnWithdrawalQuantityFields
                intermediate={props.intermediate}
                preparation={preparation}
              />
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

function EarnWithdrawalQuantityFields({
  intermediate,
  preparation,
}: {
  intermediate?: boolean;
  preparation: ReturnType<typeof useEarnPreparation>;
}) {
  const t = useTranslations();
  const { withdrawUnit, setWithdrawUnit, tokenMint, withdrawAll, setWithdrawAll } = preparation;
  return (
    <div className="space-y-2">
      {!intermediate ? (
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
      <Button type="button" variant="secondary" onClick={() => setWithdrawAll((all) => !all)}>
        {withdrawAll ? t("DashboardEarn.core.customAmount") : t("DashboardEarn.core.withdrawAll")}
      </Button>
    </div>
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
  const [optionId, setOptionId] = useState<string | null>(null);
  const terminal = isEarnOperationTerminal(operation);
  const selectedOption = optionId ?? operation.terms.options[0]?.id;
  const expired =
    operation.terms.expiresAt !== null && Date.parse(operation.terms.expiresAt) <= Date.now();

  const { busy, error, act } = useEarnOperationActions(
    operation,
    selectedOption,
    onUpdated,
    update,
    refresh
  );

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
      <EarnOperationStatus operation={operation} expired={expired} terminal={terminal} />
      {operation.error ? <Callout variant="danger">{operation.error.message}</Callout> : null}
      {error ? <Callout variant="danger">{error}</Callout> : null}
      {readError ? (
        <Callout variant="warning">{t("DashboardEarn.core.refreshFailed")}</Callout>
      ) : null}
      <EarnOperationActions operation={operation} busy={busy} expired={expired} onAction={act} />
    </div>
  );
}

function EarnOperationActions({
  operation,
  busy,
  expired,
  onAction,
}: {
  operation: Operation;
  busy: boolean;
  expired: boolean;
  onAction: (action: "execute" | "cancel" | "refresh") => Promise<void>;
}) {
  const t = useTranslations();
  if (isEarnOperationTerminal(operation)) return null;
  const nextAction = operation.nextAction;
  const canRefresh =
    (operation.status === "prepared" && nextAction?.type === "execute") ||
    nextAction?.type === "refresh";
  return (
    <div className="flex flex-wrap justify-end gap-3 pt-4">
      <Button variant="secondary" loading={busy} onClick={() => void onAction("cancel")}>
        {t("DashboardEarn.core.cancel")}
      </Button>
      {canRefresh ? (
        <Button variant="secondary" disabled={busy} onClick={() => void onAction("refresh")}>
          {t("DashboardEarn.core.refreshTerms")}
        </Button>
      ) : null}
      {nextAction?.type === "execute" ? (
        <Button loading={busy} disabled={expired} onClick={() => void onAction("execute")}>
          {t("DashboardEarn.core.execute")}
        </Button>
      ) : null}
    </div>
  );
}

function EarnOperationTerms({ operation }: { operation: Operation }) {
  const t = useTranslations();
  const locale = useLocale();
  const requestedAmount = requestedOperationAmount(operation, locale, t);
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
        {quotedOperationFees(operation, locale, t)}
      </DetailRow>
    </DetailList>
  );
}

function EarnOperationStatus({
  operation,
  expired,
  terminal,
}: {
  operation: Operation;
  expired: boolean;
  terminal: boolean;
}) {
  const t = useTranslations();
  const nextAction = operation.nextAction;
  return (
    <>
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
        <Callout variant="info">{t("DashboardEarn.core.walletSignature")}</Callout>
      ) : null}
      {operation.status === "settling" ? (
        <p className="text-caption text-secondary">{t("DashboardEarn.core.settlementNote")}</p>
      ) : null}
      {expired && !terminal ? (
        <Callout variant="warning">{t("DashboardEarn.core.expired")}</Callout>
      ) : null}
    </>
  );
}

function requestedOperationAmount(
  operation: Operation,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  const input = operation.terms.inputAmount;
  if (input) return formatTokenValue(input.value, input.mint, locale);
  if (operation.intent.kind === "earn.deposit") {
    const { amount } = operation.intent;
    return formatTokenValue(amount.value, amount.mint, locale);
  }
  const { amount } = operation.intent;
  if (amount.kind === "all") return t("DashboardEarn.core.allHoldings");
  if (amount.kind === "shares") return `${amount.value} ${t("DashboardEarn.core.shares")}`;
  return formatTokenValue(amount.value, amount.mint, locale);
}

function quotedOperationFees(
  operation: Operation,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  const { fees } = operation.terms;
  if (fees === null) return t("DashboardEarn.core.unknownFees");
  if (fees.length === 0) return t("DashboardEarn.core.noFees");
  return fees.map((fee) => formatTokenValue(fee.value, fee.mint, locale)).join(", ");
}

function EarnFundingSourceFields({
  strategy,
  preparation,
}: {
  strategy: EarnStrategy;
  preparation: ReturnType<typeof useEarnPreparation>;
}) {
  const t = useTranslations();
  const { eligibleWallets, selectedWallet, tokenMint, setWalletId, setMint } = preparation;
  return (
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
          {strategy.depositMints.map((address) => (
            <SelectItem key={address} value={address}>
              {tokenSymbol(address)}
            </SelectItem>
          ))}
        </Select>
      </div>
    </>
  );
}

function useEarnOperationActions(
  operation: Operation,
  selectedOption: string | undefined,
  onUpdated: ((operation: Operation) => void) | undefined,
  update: (operation: Operation) => Promise<Operation | undefined>,
  refresh: () => Promise<Operation | undefined>
) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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

  return { busy, error, act };
}
