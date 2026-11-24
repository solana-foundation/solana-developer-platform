"use client";

import {
  EARN_SWAP_MAX_SLIPPAGE_BPS,
  type EarnStrategy,
  type EarnVaultPosition,
} from "@sdp/types/earn";
import {
  isSdpProgressOperationStatus,
  type Operation,
  type OperationIntent,
  operationIntentSchema,
} from "@sdp/types/operations";
import { Button } from "@sdp/ui/button";
import { Callout } from "@sdp/ui/callout";
import { DetailList, DetailRow } from "@sdp/ui/detail-list";
import { Input } from "@sdp/ui/input";
import { Label } from "@sdp/ui/label";
import { Modal } from "@sdp/ui/modal";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Select, SelectItem } from "@sdp/ui/select";
import { StatusText } from "@sdp/ui/status-text";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { earnCoreClient, isEarnOperationTerminal, useEarnOperation } from "@/lib/earn-core-data";
import { createIdempotencyKeyStore } from "@/lib/idempotency-key-store";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useStepFade } from "@/lib/use-step-fade";
import { useZodForm } from "@/lib/use-zod-form";
import { useEarnFundingWallets, walletDisplayName } from "./deposit/earn-funding-wallets";
import { isPositiveDecimal } from "./earn-decimal";
import {
  EARN_OPERATION_STATUS_TONE,
  formatIntentAmount,
  formatProviderAmount,
  formatShareAmount,
  formatTokenValue,
  tokenSymbol,
} from "./earn-format";
import { EARN_TRANSACTION_MODAL_FRAME } from "./earn-modal";

const operationKeys = createIdempotencyKeyStore("sdp:earn:core-actions:v1");

const WITHDRAWAL_UNITS = ["token", "shares"] as const;
const withdrawalUnitSchema = z.enum(WITHDRAWAL_UNITS);
type WithdrawalUnit = z.infer<typeof withdrawalUnitSchema>;

const POSITIVE_AMOUNT = "DashboardEarn.core.positiveAmount" satisfies MessageKey;
const INVALID_SLIPPAGE = "DashboardEarn.core.invalidSlippage" satisfies MessageKey;

/**
 * The details step as entered. A custom amount must be a positive decimal (All reads the
 * position instead), then slippage must be whole basis points within the API's cap, read as
 * `Number` reads the field. One message at a time, the amount's first.
 */
const preparationFormSchema = z
  .object({
    /** The deposit's funding wallet; null until chosen, meaning the first eligible one. */
    walletId: z.string().nullable(),
    /** The deposit mint; null until chosen, meaning the strategy's first. */
    mint: z.string().nullable(),
    amount: z.string(),
    withdrawAll: z.boolean(),
    withdrawUnit: withdrawalUnitSchema,
    slippage: z.string(),
  })
  .transform((values, ctx) => {
    if (!values.withdrawAll && !isPositiveDecimal(values.amount)) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: POSITIVE_AMOUNT });
      return z.NEVER;
    }
    const slippageBps = Number(values.slippage);
    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > EARN_SWAP_MAX_SLIPPAGE_BPS
    ) {
      ctx.addIssue({ code: "custom", path: ["slippage"], message: INVALID_SLIPPAGE });
      return z.NEVER;
    }
    return { ...values, slippageBps };
  });

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
        optionId ? { ...reviewed, optionId } : reviewed,
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
  unit: WithdrawalUnit,
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
  unit: WithdrawalUnit
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
  const form = useZodForm(
    preparationFormSchema,
    {
      walletId: null,
      mint: null,
      amount: "",
      withdrawAll: props.kind === "withdraw" && props.defaultWithdrawAll === true,
      withdrawUnit: "token",
      slippage: "50",
    },
    (message) => {
      if (message === POSITIVE_AMOUNT) return t(POSITIVE_AMOUNT);
      if (message === INVALID_SLIPPAGE) return t(INVALID_SLIPPAGE);
      return message;
    }
  );
  const [prepared, setPrepared] = useState<Operation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const eligibleWallets = wallets?.filter((wallet) => wallet.isRuntimeExecutionAllowed) ?? [];
  const selectedWallet = form.values.walletId ?? eligibleWallets[0]?.id;
  const tokenMint = preparationMint(props, form.values.mint);
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (busy || !tokenMint) return;
    setError(undefined);
    const parsed = form.validate();
    if (!parsed.ok) return;
    const { amount, withdrawAll, withdrawUnit, slippage, slippageBps } = parsed.data;
    let intent: OperationIntent;
    if (props.kind === "deposit") {
      if (!selectedWallet) return;
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
      if (props.kind === "deposit" && form.values.walletId === null && selectedWallet) {
        form.setField("walletId", selectedWallet);
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
    form,
    eligibleWallets,
    selectedWallet,
    tokenMint,
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
  const { prepared, setPrepared } = preparation;
  const focusRef = useModalFocus({
    focusKey: prepared?.id ?? "details",
    initialFocusSelector: "[data-modal-focus-target]",
    fallbackAttribute: "data-earn-strategy-id",
    fallbackValue: props.kind === "deposit" ? props.strategy.id : props.position.id,
  });
  const stepRef = useStepFade<HTMLDivElement>(actionStep(prepared));
  const title =
    props.kind === "deposit" ? t("DashboardEarn.core.deposit") : t("DashboardEarn.core.withdraw");
  const strategyName = props.kind === "deposit" ? props.strategy.name : props.position.label;

  return (
    <Modal {...EARN_TRANSACTION_MODAL_FRAME} isOpen ariaLabel={title} onClose={props.onClose}>
      <div className="p-6" ref={focusRef}>
        <h2
          className="pr-8 text-subheading font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {title}
        </h2>
        <p className="mt-2 text-body text-secondary">{strategyName}</p>
        <div ref={stepRef}>
          {prepared ? (
            <EarnOperationReview
              operation={prepared}
              onUpdated={(operation) => {
                setPrepared(operation);
                props.onUpdated?.(operation);
              }}
              onDone={props.onClose}
              foreground
              shareMint={
                props.kind === "deposit" ? props.strategy.shareMint : props.position.shareMint
              }
            />
          ) : (
            <EarnPreparationForm action={props} preparation={preparation} />
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * The dialog's step, so moving between them fades instead of snapping.
 *
 * @param operation - The operation the dialog holds, once prepared.
 * @returns The step on screen.
 */
function actionStep(operation: Operation | undefined): "details" | "review" | "progress" | "done" {
  if (!operation) return "details";
  if (isEarnOperationTerminal(operation)) return "done";
  return operation.status === "prepared" ? "review" : "progress";
}

/** The details step: what to move, then a review that prepares terms without signing. */
function EarnPreparationForm({
  action,
  preparation,
}: {
  action: ActionProps;
  preparation: ReturnType<typeof useEarnPreparation>;
}) {
  const t = useTranslations();
  const { form, selectedWallet, busy, error, prepare } = preparation;
  return (
    <form className="mt-5 space-y-4" onSubmit={prepare}>
      {action.kind === "deposit" ? (
        <EarnFundingSourceFields strategy={action.strategy} preparation={preparation} />
      ) : (
        <EarnWithdrawalQuantityFields
          position={action.position}
          intermediate={action.intermediate}
          preparation={preparation}
        />
      )}
      {!form.values.withdrawAll ? (
        <EarnTextField
          id="earn-core-amount"
          label={t("DashboardEarn.core.amount")}
          inputMode="decimal"
          autoComplete="off"
          value={form.values.amount}
          error={form.errors.amount}
          disabled={busy}
          onChange={(value) => form.setField("amount", value)}
          trailing={
            action.kind === "withdraw" && !action.intermediate ? (
              <EarnWithdrawalUnitSelect preparation={preparation} />
            ) : null
          }
        />
      ) : null}
      <EarnTextField
        id="earn-core-slippage"
        label={t("DashboardEarn.core.slippage")}
        inputMode="numeric"
        value={form.values.slippage}
        error={form.errors.slippage}
        disabled={busy}
        onChange={(value) => form.setField("slippage", value)}
      />
      <p className="text-caption text-secondary">{t("DashboardEarn.core.prepareNote")}</p>
      {error ? <Callout variant="danger">{error}</Callout> : null}
      <div className="flex justify-end gap-3 pt-4">
        <Button type="button" variant="secondary" onClick={action.onClose}>
          {t("DashboardEarn.core.close")}
        </Button>
        <Button
          type="submit"
          loading={busy}
          disabled={action.kind === "deposit" && !selectedWallet}
        >
          {t("DashboardEarn.core.review")}
        </Button>
      </div>
    </form>
  );
}

/**
 * A labelled text input whose validation message sits under it and describes it.
 *
 * @param props.trailing - A control that qualifies the value, such as its unit, set beside it.
 */
function EarnTextField({
  id,
  label,
  inputMode,
  autoComplete,
  value,
  error,
  disabled,
  onChange,
  trailing,
}: {
  id: string;
  label: string;
  inputMode: "decimal" | "numeric";
  autoComplete?: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
  trailing?: ReactNode;
}) {
  const errorId = `${id}-error`;
  const input = (
    <Input
      id={id}
      inputMode={inputMode}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      autoComplete={autoComplete}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
    />
  );
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {trailing ? (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">{input}</div>
          <div className="w-32 shrink-0">{trailing}</div>
        </div>
      ) : (
        input
      )}
      {error ? (
        <p id={errorId} className="text-meta text-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the position holds, then whether to take part of it or all of it. The figures are the
 * same live position read the holdings table shows, formatted the same way.
 */
function EarnWithdrawalQuantityFields({
  position,
  intermediate,
  preparation,
}: {
  position: EarnVaultPosition;
  intermediate?: boolean;
  preparation: ReturnType<typeof useEarnPreparation>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { form, busy } = preparation;
  const pending = intermediate ? position.parIntermediate : undefined;
  return (
    <div className="space-y-4">
      <DetailList variant="summary">
        {pending ? (
          <DetailRow label={t("DashboardEarn.core.balance")} fit="figure">
            {formatTokenValue(pending.withdrawableAmount, pending.mint, locale)}
          </DetailRow>
        ) : (
          <>
            <DetailRow label={t("DashboardEarn.core.balance")} fit="figure">
              {formatTokenValue(position.tokenValue, position.tokenMint, locale)}
            </DetailRow>
            <DetailRow label={t("DashboardEarn.core.shares")} fit="figure">
              {formatProviderAmount(position.shares, locale)}
            </DetailRow>
          </>
        )}
      </DetailList>
      <SegmentedControl
        ariaLabel={t("DashboardEarn.core.withdrawalQuantity")}
        disabled={busy}
        options={[
          { value: "amount", label: t("DashboardEarn.core.customAmount") },
          { value: "all", label: t("DashboardEarn.core.withdrawAll") },
        ]}
        value={form.values.withdrawAll ? "all" : "amount"}
        onChange={(value) => form.setField("withdrawAll", value === "all")}
      />
    </div>
  );
}

/** The unit a custom withdrawal amount is read in: the deposit token or the vault's shares. */
function EarnWithdrawalUnitSelect({
  preparation,
}: {
  preparation: ReturnType<typeof useEarnPreparation>;
}) {
  const t = useTranslations();
  const { form, tokenMint, busy } = preparation;
  return (
    <Select
      value={form.values.withdrawUnit}
      ariaLabel={t("DashboardEarn.core.amountUnit")}
      disabled={busy}
      onValueChange={(value) => {
        // Only the listed units can be chosen; anything else leaves the unit as it was.
        const unit = WITHDRAWAL_UNITS.find((candidate) => candidate === value);
        if (unit) form.setField("withdrawUnit", unit);
      }}
    >
      <SelectItem value="token">{tokenSymbol(tokenMint ?? "")}</SelectItem>
      <SelectItem value="shares">{t("DashboardEarn.core.shares")}</SelectItem>
    </Select>
  );
}

/** The same review and signing UI resumes an operation recovered after reload. */
export function EarnOperationReview({
  operation: initial,
  onUpdated,
  onDone,
  shareMint,
  foreground,
}: {
  operation: Operation;
  onUpdated?: (operation: Operation) => void;
  /** Closes the dialog hosting this review; activity rows leave it out. */
  onDone?: () => void;
  /** The strategy's share mint, so amounts in it read as shares; unknown leaves mints as they are. */
  shareMint?: string;
  /** Set by the dialog the viewer has open: its operation is read every 2 s while SDP moves it. */
  foreground?: boolean;
}) {
  const t = useTranslations();
  const {
    operation: observed,
    error: readError,
    refresh,
    update,
  } = useEarnOperation(initial.id, initial, onUpdated, foreground);
  const operation = observed ?? initial;
  const terminal = isEarnOperationTerminal(operation);
  const expired =
    operation.terms.expiresAt !== null && Date.parse(operation.terms.expiresAt) <= Date.now();

  const { busy, error, act } = useEarnOperationActions(operation, onUpdated, update, refresh);

  const statusKey = `DashboardEarn.core.status.${operation.status}` as const;
  const statusTone = EARN_OPERATION_STATUS_TONE[operation.status];
  return (
    <div className="mt-5 space-y-4" aria-live="polite">
      <p className="text-body font-medium text-primary">
        {statusTone ? <StatusText tone={statusTone}>{t(statusKey)}</StatusText> : t(statusKey)}
      </p>
      {operation.terms.description ? (
        <p className="text-body text-secondary">{operation.terms.description}</p>
      ) : null}
      <EarnOperationTerms operation={operation} shareMint={shareMint} />
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
      <EarnOperationActions
        operation={operation}
        busy={busy}
        expired={expired}
        onAction={act}
        onDone={onDone}
      />
    </div>
  );
}

function EarnOperationActions({
  operation,
  busy,
  expired,
  onAction,
  onDone,
}: {
  operation: Operation;
  busy: boolean;
  expired: boolean;
  onAction: (action: "submit" | "cancel" | "refresh") => Promise<void>;
  onDone?: () => void;
}) {
  const t = useTranslations();
  if (isEarnOperationTerminal(operation)) {
    return onDone ? (
      <div className="flex justify-end pt-4">
        <Button onClick={onDone}>
          {t(
            operation.status === "completed"
              ? "DashboardEarn.core.done"
              : "DashboardEarn.core.close"
          )}
        </Button>
      </div>
    ) : null;
  }
  const nextAction = operation.nextAction;
  const canRefresh = operation.status === "prepared" && nextAction?.type === "refresh";
  if (operation.status !== "prepared" && !operation.canCancel && nextAction?.type !== "submit") {
    // Accepted work with nothing left to decide: the dialog can close while it carries on.
    return onDone ? (
      <div className="flex items-center justify-between gap-3 pt-4">
        <p className="text-caption text-secondary">{t("DashboardEarn.core.continuesInActivity")}</p>
        <Button variant="secondary" onClick={onDone}>
          {t("DashboardEarn.core.close")}
        </Button>
      </div>
    ) : null;
  }
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

function EarnOperationTerms({
  operation,
  shareMint,
}: {
  operation: Operation;
  shareMint: string | undefined;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const requestedAmount = requestedOperationAmount(operation, shareMint, locale, t);
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
          {formatOperationAmount(operation.terms.estimate, shareMint, locale, t)}
        </DetailRow>
      ) : null}
      {operation.terms.minimum ? (
        <DetailRow label={t("DashboardEarn.core.minimum")}>
          {formatOperationAmount(operation.terms.minimum, shareMint, locale, t)}
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
        <EarnOperationPending
          reason={nextAction.reason}
          live={isSdpProgressOperationStatus(operation.status)}
        />
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

/**
 * Work still under way, centred so progress reads at a glance. While SDP itself is moving
 * (`live`), a halo leaves the dot and the words breathe on one beat (keyframes in
 * `globals.css`); a provider wait that can last days keeps the dot still. Reduced motion keeps
 * both still, and the review's polite live region announces the words.
 *
 * @param props.reason - The API's own words for what the operation is waiting on.
 * @param props.live - Whether the wait is a short SDP-side step worth animating.
 * @returns The pending status line.
 */
function EarnOperationPending({ reason, live }: { reason: string; live: boolean }) {
  return (
    <p className="flex items-center justify-center gap-2.5 py-3 text-body text-secondary">
      <span aria-hidden="true" className="relative flex size-2 shrink-0">
        {live ? (
          <span className="absolute inset-0 rounded-full bg-info motion-safe:animate-[earn-pending-halo_2.4s_cubic-bezier(0,0,0.2,1)_infinite]" />
        ) : null}
        <span className="relative size-2 rounded-full bg-info" />
      </span>
      <span
        className={
          live ? "motion-safe:animate-[earn-pending-breathe_2.4s_ease-in-out_infinite]" : undefined
        }
      >
        {reason}
      </span>
    </p>
  );
}

/**
 * An amount in an operation's terms. A strategy's share token carries no symbol, so an amount in
 * the strategy's own share mint reads as shares; every other mint formats as itself, an unknown
 * one as its shortened address rather than a unit it might not be.
 *
 * @param amount - The quoted mint and decimal value.
 * @param shareMint - The strategy's share mint, when the caller knows it.
 * @param locale - The viewer's locale.
 * @param t - The translator.
 * @returns The amount as the review shows it.
 */
function formatOperationAmount(
  amount: { mint: string; value: string },
  shareMint: string | undefined,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  return amount.mint === shareMint
    ? formatShareAmount(amount.value, locale, t)
    : formatTokenValue(amount.value, amount.mint, locale);
}

function requestedOperationAmount(
  operation: Operation,
  shareMint: string | undefined,
  locale: string,
  t: ReturnType<typeof useTranslations>
): string {
  const input = operation.terms.inputAmount;
  if (input) return formatOperationAmount(input, shareMint, locale, t);
  return formatIntentAmount(operation.intent, locale, t);
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
  const { form, eligibleWallets, selectedWallet, tokenMint, busy } = preparation;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="earn-core-wallet">{t("DashboardEarn.core.wallet")}</Label>
        <Select
          id="earn-core-wallet"
          value={selectedWallet}
          disabled={busy}
          onValueChange={(walletId) => form.setField("walletId", walletId)}
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
        <Select
          id="earn-core-token"
          value={tokenMint}
          disabled={busy}
          onValueChange={(mint) => form.setField("mint", mint)}
        >
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
