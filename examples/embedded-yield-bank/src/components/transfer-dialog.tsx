import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isPositiveDecimal } from "@/lib/decimal";
import { currencyPrefix, formatAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { YieldStrategy } from "@/types";

export type TransferDirection = "to-savings" | "to-checking";

/** Collect intent only; current terms and signing belong to operation review. */
export function TransferDialog({
  direction,
  symbol,
  available,
  strategy,
  busy,
  disabledReason,
  variant = "default",
  onSubmit,
}: {
  direction: TransferDirection;
  symbol: string;
  available: string | undefined;
  strategy: YieldStrategy;
  busy: boolean;
  disabledReason?: string;
  variant?: "default" | "outline";
  onSubmit: (input: { amount: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const saving = direction === "to-savings";
  const title = saving ? "Move to savings" : "Move to checking";
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) setAmount("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!isPositiveDecimal(amount.trim()) || busy) return;
    try {
      await onSubmit({ amount: amount.trim() });
      changeOpen(false);
    } catch {
      /* The parent reports the error and keeps the entered amount. */
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <TransferDialogTrigger
        busy={busy}
        disabledReason={disabledReason}
        title={title}
        variant={variant}
      />
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        <form className="flex flex-col gap-5" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {saving
                ? `From checking into ${strategy.name}.`
                : `From ${strategy.name} to checking.`}
            </DialogDescription>
          </DialogHeader>
          <TransferAmountField
            amount={amount}
            available={available}
            from={saving ? "checking" : "savings"}
            inputId={`${direction}-amount`}
            onAmountChange={setAmount}
            prefix={currencyPrefix(symbol)}
            symbol={symbol}
          />
          <p className="text-sm text-muted-foreground">
            Live proceeds, fees and withdrawal routes are shown before you
            approve execution.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={busy || !isPositiveDecimal(amount.trim())}
            >
              {busy ? (
                <LoaderCircleIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Review terms
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialogTrigger({
  busy,
  disabledReason,
  title,
  variant,
}: {
  busy: boolean;
  disabledReason?: string;
  title: string;
  variant: "default" | "outline";
}) {
  const trigger = (
    <Button
      type="button"
      variant={variant}
      size="lg"
      className="px-4"
      disabled={Boolean(disabledReason) || busy}
    >
      {title}
    </Button>
  );

  if (disabledReason) {
    return (
      <span className="inline-flex" title={disabledReason}>
        {trigger}
      </span>
    );
  }
  return <DialogTrigger asChild>{trigger}</DialogTrigger>;
}

function TransferAmountField({
  amount,
  available,
  from,
  inputId,
  onAmountChange,
  prefix,
  symbol,
}: {
  amount: string;
  available: string | undefined;
  from: string;
  inputId: string;
  onAmountChange: (value: string) => void;
  prefix: string;
  symbol: string;
}) {
  const canUseMax = available !== undefined && available !== "0";
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>Amount</FieldLabel>
      <div className="relative">
        {prefix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lg text-muted-foreground"
          >
            {prefix}
          </span>
        ) : null}
        <Input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={amount}
          onChange={(event) => onAmountChange(event.target.value)}
          className={cn(
            "h-12 pr-16 text-lg tabular-nums md:text-lg",
            prefix && "pl-7"
          )}
          required
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground"
          disabled={!canUseMax}
          onClick={() => available && onAmountChange(available)}
        >
          Max
        </Button>
      </div>
      <FieldDescription>
        {available === undefined
          ? `Your ${from} balance is still updating.`
          : `${formatAmount(available, symbol)} available in ${from}.`}
      </FieldDescription>
    </Field>
  );
}
