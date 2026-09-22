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
import type {
  FeePayer,
  WithdrawalIntent,
  YieldStrategy,
  YieldWithdrawalOptions,
} from "@/types";

export type TransferDirection = "to-savings" | "to-checking";

interface TransferDialogProps {
  direction: TransferDirection;
  symbol: string;
  /** Amount that can move right now, or undefined while it is still unknown. */
  available: string | undefined;
  strategy: YieldStrategy;
  withdrawalOptions?: YieldWithdrawalOptions | null;
  feesPaidBy: FeePayer;
  busy: boolean;
  /** When set, the trigger is disabled and explains why on hover. */
  disabledReason?: string;
  variant?: "default" | "outline";
  onSubmit: (
    input: WithdrawalIntent | { amount: string; route: "deposit" }
  ) => Promise<void>;
}

type WithdrawalRoute = WithdrawalIntent["route"];

interface DurationUnit {
  divisor: number;
  label: "seconds" | "minutes" | "hours" | "days";
}

interface WithdrawalRouteAvailability {
  direct: boolean;
  queued: boolean;
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
  withdrawalOptions,
  feesPaidBy,
  busy,
  disabledReason,
  variant = "default",
  onSubmit,
}: TransferDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [withdrawalRoute, setWithdrawalRoute] = useState<WithdrawalRoute>(() =>
    defaultWithdrawalRoute(withdrawalOptions)
  );
  const queueTerms = withdrawalOptions?.queueAsset ?? null;
  const durationUnit = queueDurationUnit(
    queueTerms?.minimumSecondsToDeadline ?? 60
  );
  const [discountPercent, setDiscountPercent] = useState(() =>
    formatBasisPoints(queueTerms?.minimumDiscountBps ?? 0)
  );
  const [deadline, setDeadline] = useState(() =>
    String((queueTerms?.minimumSecondsToDeadline ?? 60) / durationUnit.divisor)
  );
  const copy = COPY[direction];
  const availability = withdrawalRouteAvailability(
    withdrawalOptions,
    queueTerms
  );
  const showRouteChoice = shouldShowRouteChoice(direction, availability);
  const selectedRouteAvailable = isSelectedRouteAvailable(
    direction,
    withdrawalRoute,
    availability
  );
  const inputId = `${direction}-amount`;
  const prefix = currencyPrefix(symbol);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAmount("");
      return;
    }
    const nextRoute = defaultWithdrawalRoute(withdrawalOptions);
    const nextTerms = withdrawalOptions?.queueAsset;
    const nextUnit = queueDurationUnit(
      nextTerms?.minimumSecondsToDeadline ?? 60
    );
    setWithdrawalRoute(nextRoute);
    setDiscountPercent(formatBasisPoints(nextTerms?.minimumDiscountBps ?? 0));
    setDeadline(
      String((nextTerms?.minimumSecondsToDeadline ?? 60) / nextUnit.divisor)
    );
  }

  const discountBps = parsePercentToBasisPoints(discountPercent);
  const deadlineSeconds = parseDurationSeconds(deadline, durationUnit);
  const queueSettingsValid = areQueueSettingsValid(
    queueTerms,
    discountBps,
    deadlineSeconds
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const input = transferIntent({
        amount,
        direction,
        withdrawalRoute,
        queueSettingsValid,
        discountBps,
        deadlineSeconds,
      });
      if (!input) return;
      await onSubmit(input);
      handleOpenChange(false);
    } catch {
      // App owns the toast. Keep the dialog open so the customer can adjust.
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <TransferDialogTrigger
        busy={busy}
        disabledReason={disabledReason}
        title={copy.title}
        variant={variant}
      />
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>

          <TransferAmountField
            amount={amount}
            available={available}
            from={copy.from}
            inputId={inputId}
            onAmountChange={setAmount}
            prefix={prefix}
            symbol={symbol}
          />
          <WithdrawalRouteChooser
            options={withdrawalOptions}
            route={withdrawalRoute}
            show={showRouteChoice}
            onRouteChange={setWithdrawalRoute}
          />
          <QueuedWithdrawalFields
            active={direction === "to-checking" && withdrawalRoute === "queued"}
            deadline={deadline}
            discountPercent={discountPercent}
            durationUnit={durationUnit}
            queueSettingsValid={queueSettingsValid}
            queueTerms={queueTerms}
            onDeadlineChange={setDeadline}
            onDiscountChange={setDiscountPercent}
          />
          <TransferSummary
            direction={direction}
            discountPercent={discountPercent}
            feesPaidBy={feesPaidBy}
            options={withdrawalOptions}
            queueTerms={queueTerms}
            route={withdrawalRoute}
            strategy={strategy}
          />
          <TransferDialogFooter
            amount={amount}
            busy={busy}
            queueSettingsValid={queueSettingsValid}
            route={withdrawalRoute}
            selectedRouteAvailable={selectedRouteAvailable}
            title={copy.title}
          />
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

function WithdrawalRouteChooser({
  options,
  route,
  show,
  onRouteChange,
}: {
  options: YieldWithdrawalOptions | null | undefined;
  route: WithdrawalRoute;
  show: boolean;
  onRouteChange: (route: WithdrawalRoute) => void;
}) {
  if (!show) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">How to withdraw</legend>
      <WithdrawalRouteOption
        checked={route === "direct"}
        description={directRouteDescription(options)}
        label={options?.instant ? "Withdraw now" : "Provider redemption"}
        onChange={() => onRouteChange("direct")}
        value="direct"
      />
      <WithdrawalRouteOption
        checked={route === "queued"}
        description="Escrow shares now, then wait for a solver payment or recover them after the deadline."
        label="Queued withdrawal"
        onChange={() => onRouteChange("queued")}
        value="queued"
      />
    </fieldset>
  );
}

function QueuedWithdrawalFields({
  active,
  deadline,
  discountPercent,
  durationUnit,
  queueSettingsValid,
  queueTerms,
  onDeadlineChange,
  onDiscountChange,
}: {
  active: boolean;
  deadline: string;
  discountPercent: string;
  durationUnit: DurationUnit;
  queueSettingsValid: boolean;
  queueTerms: YieldWithdrawalOptions["queueAsset"];
  onDeadlineChange: (value: string) => void;
  onDiscountChange: (value: string) => void;
}) {
  if (!active || !queueTerms) return null;
  return (
    <div className="grid gap-4 rounded-xl border p-4">
      <p className="text-sm leading-5 text-muted-foreground">
        This request locks shares and pays later. It is not a completed transfer
        until SDP reports fulfillment.
      </p>
      <Field>
        <FieldLabel htmlFor="queued-discount">Accept less (%)</FieldLabel>
        <Input
          id="queued-discount"
          inputMode="decimal"
          value={discountPercent}
          onChange={(event) => onDiscountChange(event.target.value)}
        />
        <FieldDescription>
          Allowed: {formatBasisPoints(queueTerms.minimumDiscountBps)}% to{" "}
          {formatBasisPoints(queueTerms.maximumDiscountBps)}%.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="queued-deadline">
          Solver window ({durationUnit.label})
        </FieldLabel>
        <Input
          id="queued-deadline"
          inputMode="decimal"
          value={deadline}
          onChange={(event) => onDeadlineChange(event.target.value)}
        />
        <FieldDescription>
          Allowed: {formatDuration(queueTerms.minimumSecondsToDeadline)} to{" "}
          {formatDuration(queueTerms.maximumSecondsToDeadline)} after maturity.
        </FieldDescription>
      </Field>
      {!queueSettingsValid ? (
        <p className="text-sm text-destructive" role="alert">
          Use the allowed discount and solver window.
        </p>
      ) : null}
    </div>
  );
}

function TransferSummary({
  direction,
  discountPercent,
  feesPaidBy,
  options,
  queueTerms,
  route,
  strategy,
}: {
  direction: TransferDirection;
  discountPercent: string;
  feesPaidBy: FeePayer;
  options: YieldWithdrawalOptions | null | undefined;
  queueTerms: YieldWithdrawalOptions["queueAsset"];
  route: WithdrawalRoute;
  strategy: YieldStrategy;
}) {
  return (
    <dl className="flex flex-col gap-2.5 rounded-xl bg-muted/60 p-4 text-sm">
      <SummaryRow label="Savings account" value={strategy.name} />
      {direction === "to-savings" ? (
        <SummaryRow label="Rate" value={formatApy(strategy.currentApy)} />
      ) : route === "queued" && queueTerms ? (
        <>
          <SummaryRow label="Route" value="Queued withdrawal" />
          <SummaryRow
            label="Matures"
            value={`In about ${formatDuration(queueTerms.secondsToMaturity)}`}
          />
          <SummaryRow
            label="Accept less"
            value={`${discountPercent || "0"}%`}
          />
        </>
      ) : (
        <SummaryRow
          label="Arrives"
          value={options?.instant ? "Right away" : arrivalCopy(strategy)}
        />
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
  );
}

function TransferDialogFooter({
  amount,
  busy,
  queueSettingsValid,
  route,
  selectedRouteAvailable,
  title,
}: {
  amount: string;
  busy: boolean;
  queueSettingsValid: boolean;
  route: WithdrawalRoute;
  selectedRouteAvailable: boolean;
  title: string;
}) {
  const disabled =
    busy ||
    !amount.trim() ||
    !selectedRouteAvailable ||
    (route === "queued" && !queueSettingsValid);
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline" disabled={busy}>
          Cancel
        </Button>
      </DialogClose>
      <Button type="submit" disabled={disabled}>
        {busy ? (
          <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
        ) : null}
        {title}
      </Button>
    </DialogFooter>
  );
}

function WithdrawalRouteOption({
  checked,
  description,
  label,
  onChange,
  value,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: () => void;
  value: WithdrawalRoute;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 has-checked:border-foreground/30 has-checked:bg-muted/50">
      <input
        className="mt-1"
        type="radio"
        name="withdrawal-route"
        value={value}
        checked={checked}
        onChange={onChange}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

function withdrawalRouteAvailability(
  options: YieldWithdrawalOptions | null | undefined,
  queueTerms: YieldWithdrawalOptions["queueAsset"]
): WithdrawalRouteAvailability {
  return {
    direct: Boolean(options?.instant || options?.providerOrder),
    queued: Boolean(options?.queued && queueTerms?.allowWithdrawals),
  };
}

function shouldShowRouteChoice(
  direction: TransferDirection,
  availability: WithdrawalRouteAvailability
): boolean {
  return (
    direction === "to-checking" && availability.direct && availability.queued
  );
}

function isSelectedRouteAvailable(
  direction: TransferDirection,
  route: WithdrawalRoute,
  availability: WithdrawalRouteAvailability
): boolean {
  if (direction === "to-savings") return true;
  return route === "direct" ? availability.direct : availability.queued;
}

function areQueueSettingsValid(
  queueTerms: YieldWithdrawalOptions["queueAsset"],
  discountBps: number,
  deadlineSeconds: number
): boolean {
  return Boolean(
    queueTerms &&
      Number.isInteger(discountBps) &&
      discountBps >= queueTerms.minimumDiscountBps &&
      discountBps <= queueTerms.maximumDiscountBps &&
      Number.isInteger(deadlineSeconds) &&
      deadlineSeconds >= queueTerms.minimumSecondsToDeadline &&
      deadlineSeconds <= queueTerms.maximumSecondsToDeadline
  );
}

function transferIntent({
  amount,
  direction,
  withdrawalRoute,
  queueSettingsValid,
  discountBps,
  deadlineSeconds,
}: {
  amount: string;
  direction: TransferDirection;
  withdrawalRoute: WithdrawalRoute;
  queueSettingsValid: boolean;
  discountBps: number;
  deadlineSeconds: number;
}): WithdrawalIntent | { amount: string; route: "deposit" } | null {
  const normalizedAmount = amount.trim();
  if (direction === "to-savings") {
    return { amount: normalizedAmount, route: "deposit" };
  }
  if (withdrawalRoute === "queued") {
    if (!queueSettingsValid) return null;
    return {
      amount: normalizedAmount,
      route: "queued",
      discountBps,
      deadlineSeconds,
    };
  }
  return { amount: normalizedAmount, route: "direct" };
}

function directRouteDescription(
  options: YieldWithdrawalOptions | null | undefined
): string {
  if (options?.instant) return "Assets arrive in the same transaction.";
  return "The provider settles the redemption after it receives your shares.";
}

function defaultWithdrawalRoute(
  options: YieldWithdrawalOptions | null | undefined
): WithdrawalRoute {
  return options?.instant || options?.providerOrder ? "direct" : "queued";
}

function formatBasisPoints(value: number): string {
  return String(value / 100);
}

function parsePercentToBasisPoints(value: string): number {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function queueDurationUnit(seconds: number): DurationUnit {
  if (seconds >= 86_400 && seconds % 86_400 === 0)
    return { divisor: 86_400, label: "days" };
  if (seconds >= 3_600 && seconds % 3_600 === 0)
    return { divisor: 3_600, label: "hours" };
  if (seconds >= 60 && seconds % 60 === 0)
    return { divisor: 60, label: "minutes" };
  return { divisor: 1, label: "seconds" };
}

function parseDurationSeconds(value: string, unit: DurationUnit): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return Number.NaN;
  const fraction = match[2] ?? "";
  const denominator = 10n ** BigInt(fraction.length);
  const units = BigInt(`${match[1]}${fraction}`);
  const scaled = units * BigInt(unit.divisor);
  if (scaled % denominator !== 0n) return Number.NaN;
  const seconds = scaled / denominator;
  return seconds > 0n && seconds <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(seconds)
    : Number.NaN;
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0)
    return `${seconds / 86_400} ${seconds === 86_400 ? "day" : "days"}`;
  if (seconds % 3_600 === 0)
    return `${seconds / 3_600} ${seconds === 3_600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0)
    return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
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
