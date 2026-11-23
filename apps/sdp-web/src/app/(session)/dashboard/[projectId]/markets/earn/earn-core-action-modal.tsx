"use client";

import {
  EARN_SWAP_MAX_SLIPPAGE_BPS,
  type EarnStrategy,
  type EarnVaultPosition,
} from "@sdp/types/earn";
import { type Operation, type OperationIntent, operationIntentSchema } from "@sdp/types/operations";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { Select, SelectItem } from "@sdp/ui/select";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
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

const preparationClaimSchema = z.strictObject({
  key: z.uuid(),
  intent: operationIntentSchema,
});

function restorePreparation(kept: string) {
  try {
    return preparationClaimSchema.parse(JSON.parse(kept));
  } catch {
    throw new Error(
      "The saved preparation is unavailable. Check activity before starting another request."
    );
  }
}

function durableKey(fingerprint: string, mint?: () => string): string {
  const claim = operationKeys.claim(fingerprint, mint);
  if (!claim.persisted)
    throw new Error(
      "Save access is required to safely retry this action. Enable browser storage and try again."
    );
  return claim.key;
}

/** Send one version-bound action under its retained retry key. */
function sendOperationAction(
  operation: Operation,
  action: "submit" | "cancel" | "refresh",
  optionId: string | undefined,
  key: string
): Promise<Operation> {
  const reviewed = { actionId: operation.actionId, version: operation.version };
  switch (action) {
    case "submit":
      return earnCoreClient.submit(operation.id, reviewed, key);
    case "cancel":
      return earnCoreClient.cancel(operation.id, key);
    case "refresh":
      return earnCoreClient.refresh(
        operation.id,
        { ...reviewed, ...(optionId ? { optionId } : {}) },
        key
      );
    default: {
      const unknownAction: never = action;
      throw new Error(`Unknown operation action: ${unknownAction}`);
    }
  }
}

type ActionProps = {
  onClose: () => void;
  onUpdated?: (operation: Operation) => void;
} & (
  | { kind: "deposit"; strategy: EarnStrategy }
  | {
      kind: "withdraw";
      position: EarnVaultPosition;
      intermediate?: boolean;
      /** Opens with All selected: the API offers recovery routes only to an All withdrawal. */
      defaultWithdrawAll?: boolean;
    }
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
  return {
    kind: "earn.withdraw",
    positionId: props.position.id,
    amount: withdrawalQuantity(props.position.tokenMint, amount, withdrawAll, unit),
    slippageBps,
  };
}

function withdrawalQuantity(
  tokenMint: string,
  amount: string,
  withdrawAll: boolean,
  unit: "token" | "shares"
): Extract<OperationIntent, { kind: "earn.withdraw" }>["amount"] {
  if (withdrawAll) return { kind: "all" };
  switch (unit) {
    case "shares":
      return { kind: "shares", value: amount };
    case "token":
      return { kind: "token", mint: tokenMint, value: amount };
    default: {
      const unknownUnit: never = unit;
      throw new Error(`Unknown withdrawal unit: ${unknownUnit}`);
    }
  }
}

/** The mint a preparation spends: the chosen funding mint, or the position's exit mint. */
function preparationMint(props: ActionProps, chosenMint: string | null): string | undefined {
  if (props.kind === "deposit") return chosenMint ?? props.strategy.depositMints[0];
  return props.intermediate ? props.position.parIntermediate?.mint : props.position.tokenMint;
}

function useEarnPreparation(props: ActionProps) {
  const t = useTranslations();
  const workspace = useOptionalDashboardWorkspace();
  const { wallets } = useEarnFundingWallets();
  const [walletId, setWalletId] = useState<string | null>(null);
  const [mint, setMint] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [withdrawAll, setWithdrawAll] = useState(
    props.kind === "withdraw" && props.defaultWithdrawAll === true
  );
  const [withdrawUnit, setWithdrawUnit] = useState<"token" | "shares">("token");
  const [slippage, setSlippage] = useState("50");
  const [prepared, setPrepared] = useState<Operation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const eligibleWallets = wallets?.filter((wallet) => wallet.isRuntimeExecutionAllowed) ?? [];
  const selectedWallet = walletId ?? eligibleWallets[0]?.id;
  const tokenMint = preparationMint(props, mint);
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy || !tokenMint) return;
    setError(undefined);
    if (!withdrawAll && !isPositiveDecimal(amount)) {
      setError(t("DashboardEarn.core.positiveAmount"));
      return;
    }
    const slippageBps = Number(slippage);
    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > EARN_SWAP_MAX_SLIPPAGE_BPS
    ) {
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
    const fingerprint = JSON.stringify([
      workspace?.selectedProjectId,
      "prepare",
      props.kind,
      props.kind === "deposit" ? props.strategy.id : props.position.id,
      props.kind === "deposit" ? selectedWallet : props.position.custodyWalletId,
      tokenMint,
      props.kind === "withdraw" && props.intermediate === true,
      withdrawAll ? null : amount,
      withdrawAll,
      withdrawUnit,
      slippage,
    ]);
    setBusy(true);
    try {
      // Store the exact request with its key: All can depend on a live balance.
      const kept = durableKey(fingerprint, () =>
        JSON.stringify({ key: crypto.randomUUID(), intent })
      );
      const retained = restorePreparation(kept);
      if (props.kind === "deposit" && walletId === null && selectedWallet) {
        setWalletId(selectedWallet);
      }
      let operation: Operation;
      if (retained.intent.kind === "earn.deposit") {
        const { kind: _, ...body } = retained.intent;
        operation = await earnCoreClient.deposit(body, retained.key);
      } else {
        const { kind: _, ...body } = retained.intent;
        operation = await earnCoreClient.withdraw(body, retained.key);
      }
      operationKeys.release(fingerprint, kept);
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

/** Preparation reviews terms; only the following explicit action can request wallet signing. */
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

/** The same review and signing UI resumes an operation recovered after reload. */
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
  const terminal = isEarnOperationTerminal(operation);
  const expired =
    operation.terms.expiresAt !== null && Date.parse(operation.terms.expiresAt) <= Date.now();

  const { busy, error, act } = useEarnOperationActions(operation, onUpdated, update, refresh);

  const statusKey = `DashboardEarn.core.status.${operation.status}` as const;
  return (
    <div className="mt-5 space-y-4" aria-live="polite">
      <p className="text-body font-medium text-primary">{t(statusKey)}</p>
      {operation.terms.description ? (
        <p className="text-body text-secondary">{operation.terms.description}</p>
      ) : null}
      <EarnOperationTerms operation={operation} />
      {operation.status === "prepared" && operation.nextAction?.type === "select_option" ? (
        <div className="space-y-2">
          <Label htmlFor={`earn-option-${operation.id}`}>{t("DashboardEarn.core.route")}</Label>
          <Select
            id={`earn-option-${operation.id}`}
            value={null}
            disabled={busy}
            placeholder={t("DashboardEarn.core.chooseRoute")}
            onValueChange={(optionId) => {
              if (optionId) void act("refresh", optionId);
            }}
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
  onAction: (action: "submit" | "cancel" | "refresh") => Promise<void>;
}) {
  const t = useTranslations();
  if (isEarnOperationTerminal(operation)) return null;
  const nextAction = operation.nextAction;
  const canRefresh = operation.status === "prepared" && nextAction?.type === "refresh";
  return (
    <div className="flex flex-wrap justify-end gap-3 pt-4">
      {operation.canCancel ? (
        <Button variant="secondary" loading={busy} onClick={() => void onAction("cancel")}>
          {t("DashboardEarn.core.cancel")}
        </Button>
      ) : null}
      {canRefresh ? (
        <Button variant="secondary" disabled={busy} onClick={() => void onAction("refresh")}>
          {t("DashboardEarn.core.refreshTerms")}
        </Button>
      ) : null}
      {nextAction?.type === "submit" ? (
        <Button loading={busy} disabled={expired} onClick={() => void onAction("submit")}>
          {t("DashboardEarn.core.submit")}
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
      {nextAction?.type === "sign_in_provider" ? (
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
  onUpdated: ((operation: Operation) => void) | undefined,
  update: (operation: Operation) => Promise<Operation | undefined>,
  refresh: () => Promise<Operation | undefined>
) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const latestOperation = useRef(operation);
  useEffect(() => {
    latestOperation.current = operation;
  }, [operation]);
  async function act(action: "submit" | "cancel" | "refresh", optionId?: string) {
    if (busy) return;
    if (action === "cancel" && !operation.canCancel) return;
    setBusy(true);
    setError(undefined);
    try {
      const fingerprint = JSON.stringify([
        operation.id,
        action,
        operation.actionId,
        operation.version,
        optionId,
      ]);
      const key = durableKey(fingerprint);
      const updated = await sendOperationAction(operation, action, optionId, key);
      if (action === "cancel") operationKeys.release(fingerprint, key);
      if (updated.version < latestOperation.current.version) return;
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
