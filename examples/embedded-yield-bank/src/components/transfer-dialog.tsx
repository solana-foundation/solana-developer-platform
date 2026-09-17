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
import { currencyPrefix, formatAmount, formatApy } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FeePayer, YieldStrategy } from "@/types";

export type TransferDirection = "to-savings" | "to-checking";

interface TransferDialogProps {
  direction: TransferDirection;
  symbol: string;
  /** Amount that can move right now, or undefined while it is still unknown. */
  available: string | undefined;
  strategy: YieldStrategy;
  feesPaidBy: FeePayer;
  busy: boolean;
  /** When set, the trigger is disabled and explains why on hover. */
  disabledReason?: string;
  variant?: "default" | "outline";
  onSubmit: (amount: string) => Promise<void>;
}

const COPY: Record<
  TransferDirection,
  { title: string; description: string; from: string }
> = {
  "to-savings": {
    title: "Move to savings",
    description: "From checking into savings. It starts earning right away.",
    from: "checking",
  },
  "to-checking": {
    title: "Move to checking",
    description: "From savings back into checking.",
    from: "savings",
  },
};

export function TransferDialog({
  direction,
  symbol,
  available,
  strategy,
  feesPaidBy,
  busy,
  disabledReason,
  variant = "default",
  onSubmit,
}: TransferDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const copy = COPY[direction];
  const canUseMax = available !== undefined && available !== "0";
  const inputId = `${direction}-amount`;
  const prefix = currencyPrefix(symbol);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setAmount("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await onSubmit(amount.trim());
      handleOpenChange(false);
    } catch {
      // App owns the toast. Keep the dialog open so the customer can adjust.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="lg"
          className="px-4"
          disabled={Boolean(disabledReason) || busy}
          title={disabledReason}
        >
          {copy.title}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>

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
                onChange={(event) => setAmount(event.target.value)}
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
                onClick={() => available && setAmount(available)}
              >
                Max
              </Button>
            </div>
            <FieldDescription>
              {available === undefined
                ? `Your ${copy.from} balance is still updating.`
                : `${formatAmount(available, symbol)} available in ${copy.from}.`}
            </FieldDescription>
          </Field>

          <dl className="flex flex-col gap-2.5 rounded-xl bg-muted/60 p-4 text-sm">
            <SummaryRow label="Savings account" value={strategy.name} />
            {direction === "to-savings" ? (
              <SummaryRow label="Rate" value={formatApy(strategy.currentApy)} />
            ) : (
              <SummaryRow label="Arrives" value={arrivalCopy(strategy)} />
            )}
            <SummaryRow
              label="Network fees"
              value={
                feesPaidBy === "northstar"
                  ? "Paid by Northstar"
                  : "Paid from your wallet"
              }
            />
          </dl>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !amount.trim()}>
              {busy ? (
                <LoaderCircleIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              {copy.title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}

export function arrivalCopy(
  strategy: Pick<YieldStrategy, "liquidityTerm" | "redemptionDelayDays">
): string {
  if (strategy.liquidityTerm === "instant") return "Right away";
  const days = strategy.redemptionDelayDays;
  return days
    ? `In about ${days} ${days === 1 ? "day" : "days"}`
    : "In a few days";
}
