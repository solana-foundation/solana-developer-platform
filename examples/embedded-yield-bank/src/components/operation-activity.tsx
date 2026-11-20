import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  refreshPreparedOperation,
  requestOperationCancellation,
  submitPreparedOperation,
} from "@/lib/core-api";
import { type EarnOperation, isOperationActive } from "@/lib/core-operation";
import { formatAmount, shortAddress } from "@/lib/format";

const STATUS: Record<EarnOperation["status"], string> = {
  prepared: "Ready for review",
  queued: "Queued for execution",
  awaiting_signature: "Waiting for a signature",
  submitted: "Submitted to Solana",
  settling: "Waiting for provider settlement",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Operations retain pending signatures and settlement without inventing paid amounts. */
export function OperationActivity({
  operations,
  strategyName,
  symbol,
  tokenMint,
  onUpdated,
}: {
  operations: EarnOperation[];
  strategyName: string;
  symbol: string;
  tokenMint: string;
  onUpdated: () => void;
}) {
  if (operations.length === 0) return null;
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Earn activity</h2>
        <p className="text-sm text-muted-foreground">{strategyName}</p>
      </div>
      <div className="divide-y rounded-xl border px-4">
        {operations.map((operation) => (
          <OperationRow
            key={operation.id}
            operation={operation}
            symbol={symbol}
            tokenMint={tokenMint}
            onUpdated={onUpdated}
          />
        ))}
      </div>
    </section>
  );
}

function OperationRow({
  operation,
  symbol,
  tokenMint,
  onUpdated,
}: {
  operation: EarnOperation;
  symbol: string;
  tokenMint: string;
  onUpdated: () => void;
}) {
  const next = operation.nextAction;
  const canSubmit =
    next?.type === "sign_transaction" || next?.type === "submit";
  const expired =
    operation.terms.expiresAt !== null &&
    Date.parse(operation.terms.expiresAt) <= Date.now();
  const settled = operation.result?.settledAmount;
  const format = (amount: { mint: string; value: string }) =>
    amount.mint === tokenMint
      ? formatAmount(amount.value, symbol)
      : `${amount.value} (${shortAddress(amount.mint)})`;

  const { busy, act } = useOperationActions(operation, onUpdated);

  const requested = requestedAmount(operation, format);

  return (
    <article className="space-y-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {operation.kind === "earn.deposit" ? "Deposit" : "Withdrawal"}:{" "}
          {requested}
        </span>
        <span className="text-sm text-muted-foreground">
          {STATUS[operation.status]}
        </span>
      </div>
      {operation.terms.description ? (
        <p className="text-sm text-muted-foreground">
          {operation.terms.description}
        </p>
      ) : null}
      {settled ? (
        <p className="text-sm">
          {operation.result?.settlementOutcome === "recovered"
            ? "Recovered"
            : operation.result?.settlementOutcome === "cancelled"
              ? "Returned"
              : "Delivered"}
          : {format(settled)}
        </p>
      ) : null}
      {canSubmit ? (
        <OperationTerms operation={operation} format={format} />
      ) : null}
      {operation.status === "prepared" && next?.type === "select_option" ? (
        <label className="flex flex-col gap-1 text-sm">
          Withdrawal route
          <select
            className="rounded-md border bg-background p-2"
            value=""
            disabled={busy}
            onChange={(event) => void act("refresh", event.target.value)}
          >
            <option value="" disabled>
              Choose withdrawal route
            </option>
            {operation.terms.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <OperationProgress
        operation={operation}
        canSubmit={canSubmit}
        expired={expired}
      />
      {operation.error ? (
        <p className="text-sm text-destructive" role="alert">
          {operation.error.message}
        </p>
      ) : null}
      <OperationActions
        operation={operation}
        busy={busy}
        expired={expired}
        onAction={act}
      />
    </article>
  );
}

function OperationActions({
  operation,
  busy,
  expired,
  onAction,
}: {
  operation: EarnOperation;
  busy: boolean;
  expired: boolean;
  onAction: (action: "submit" | "cancel" | "refresh") => Promise<void>;
}) {
  if (!isOperationActive(operation)) return null;
  const next = operation.nextAction;
  const canSubmit =
    next?.type === "submit" || next?.type === "sign_transaction";
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {operation.canCancel ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void onAction("cancel")}
        >
          Cancel
        </Button>
      ) : null}
      {operation.status === "prepared" && next?.type === "refresh" ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void onAction("refresh")}
        >
          Refresh terms
        </Button>
      ) : null}
      {canSubmit ? (
        <Button
          size="sm"
          disabled={busy || expired}
          aria-busy={busy}
          onClick={() => void onAction("submit")}
        >
          {busy ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : null}
          Confirm and submit
        </Button>
      ) : null}
    </div>
  );
}

type FormatAmount = (amount: { mint: string; value: string }) => string;

function requestedAmount(
  operation: EarnOperation,
  format: FormatAmount
): string {
  const input = operation.terms.inputAmount;
  if (input) return format(input);
  if (operation.intent.kind === "earn.deposit")
    return format(operation.intent.amount);
  const { amount } = operation.intent;
  if (amount.kind === "all") return "All holdings";
  if (amount.kind === "shares") return `${amount.value} shares`;
  return amount.mint && amount.value
    ? format({ mint: amount.mint, value: amount.value })
    : "Withdrawal";
}

function quotedFees(operation: EarnOperation, format: FormatAmount): string {
  const { fees } = operation.terms;
  if (fees === null) return "Not yet known";
  return fees.length ? fees.map(format).join(", ") : "No quoted fees";
}

function OperationTerms({
  operation,
  format,
}: {
  operation: EarnOperation;
  format: FormatAmount;
}) {
  return (
    <dl className="space-y-1 text-sm text-muted-foreground">
      {operation.terms.estimate ? (
        <div className="flex justify-between">
          <dt>Estimated proceeds</dt>
          <dd>{format(operation.terms.estimate)}</dd>
        </div>
      ) : null}
      {operation.terms.minimum ? (
        <div className="flex justify-between">
          <dt>Minimum proceeds</dt>
          <dd>{format(operation.terms.minimum)}</dd>
        </div>
      ) : null}
      <div className="flex justify-between">
        <dt>Quoted fees</dt>
        <dd>{quotedFees(operation, format)}</dd>
      </div>
    </dl>
  );
}

function OperationProgress({
  operation,
  canSubmit,
  expired,
}: {
  operation: EarnOperation;
  canSubmit: boolean;
  expired: boolean;
}) {
  const next = operation.nextAction;
  return (
    <>
      {next?.type === "sign_in_provider" ? (
        <p className="text-sm text-muted-foreground">{next.instructions}</p>
      ) : null}
      {next?.type === "wait" ? (
        <p className="text-sm text-muted-foreground">{next.reason}</p>
      ) : null}
      {operation.status === "settling" ? (
        <p className="text-sm text-muted-foreground">
          A request has been submitted. The provider has not confirmed delivery.
        </p>
      ) : null}
      {canSubmit && expired ? (
        <p className="text-sm text-muted-foreground">
          These terms expired. Wait for the operation to offer refreshed terms.
        </p>
      ) : null}
    </>
  );
}

function useOperationActions(operation: EarnOperation, onUpdated: () => void) {
  const [busy, setBusy] = useState(false);
  async function act(
    action: "submit" | "cancel" | "refresh",
    optionId?: string
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const updated =
        action === "submit"
          ? await submitPreparedOperation(operation)
          : action === "refresh"
            ? await refreshPreparedOperation(operation, optionId)
            : await requestOperationCancellation(operation);
      if (updated.status === "failed")
        throw new Error(updated.error?.message ?? "Execution failed");
      toast.info(STATUS[updated.status]);
      onUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not update this operation"
      );
    } finally {
      setBusy(false);
    }
  }

  return { busy, act };
}
