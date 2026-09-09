import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatApy, formatToken } from "@/lib/format";
import type { TokenBalance, YieldPosition, YieldStrategy } from "@/types";

interface DepositDialogProps {
  strategies: YieldStrategy[];
  balances: TokenBalance[];
  busy: boolean;
  onSubmit: (strategyId: string, amount: string) => Promise<void>;
}

export function DepositDialog({
  strategies,
  balances,
  busy,
  onSubmit,
}: DepositDialogProps) {
  const [open, setOpen] = useState(false);
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? "");
  const [amount, setAmount] = useState("25");
  const selected = strategies.find((strategy) => strategy.id === strategyId);
  const balance = balances.find(
    (item) => item.mint === selected?.depositMints[0]
  );

  useEffect(() => {
    if (!strategyId && strategies[0]) setStrategyId(strategies[0].id);
  }, [strategies, strategyId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await onSubmit(strategyId, amount);
      setOpen(false);
    } catch {
      // App owns the toast. Keep the dialog open so the customer can correct it.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={!strategies.length}>
          <ArrowDownToLineIcon data-icon="inline-start" />
          Add to yield
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add to yield</DialogTitle>
            <DialogDescription>
              Move devnet funds from your Northstar balance into an Embedded
              Yield strategy.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="deposit-strategy">Strategy</FieldLabel>
              <Select value={strategyId} onValueChange={setStrategyId}>
                <SelectTrigger id="deposit-strategy" className="w-full">
                  <SelectValue placeholder="Choose a strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {strategies.map((strategy) => (
                      <SelectItem key={strategy.id} value={strategy.id}>
                        {strategy.name} · {formatApy(strategy.currentApy)} APY
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="deposit-amount">Amount</FieldLabel>
              <Input
                id="deposit-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="25.00"
                required
              />
              <FieldDescription>
                Available:{" "}
                {balance
                  ? formatToken(balance.amount, balance.symbol)
                  : "No direct token balance"}
              </FieldDescription>
            </Field>
          </FieldGroup>

          <div className="rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
            Northstar signs the SDP-built transaction with the managed demo
            wallet. The key stays on the server and the movement is recorded
            against this sandbox project.
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !strategyId || !amount}>
              {busy ? (
                <LoaderCircleIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Confirm deposit
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface WithdrawDialogProps {
  positions: YieldPosition[];
  busy: boolean;
  initialPositionId?: string;
  trigger?: React.ReactNode;
  onSubmit: (positionId: string, shares: string) => Promise<void>;
}

export function WithdrawDialog({
  positions,
  busy,
  initialPositionId,
  trigger,
  onSubmit,
}: WithdrawDialogProps) {
  const withdrawablePositions = useMemo(
    () =>
      positions.filter((position) => position.withdrawableShares !== undefined),
    [positions]
  );
  const firstPositionId =
    initialPositionId ?? withdrawablePositions[0]?.id ?? "";
  const [open, setOpen] = useState(false);
  const [positionId, setPositionId] = useState(firstPositionId);
  const selected = withdrawablePositions.find(
    (position) => position.id === positionId
  );
  const [shares, setShares] = useState(selected?.withdrawableShares ?? "");

  useEffect(() => {
    if (!open) return;
    const nextId = initialPositionId ?? withdrawablePositions[0]?.id ?? "";
    const next = withdrawablePositions.find(
      (position) => position.id === nextId
    );
    setPositionId(nextId);
    setShares(next?.withdrawableShares ?? "");
  }, [initialPositionId, open, withdrawablePositions]);

  function changePosition(nextId: string) {
    setPositionId(nextId);
    setShares(
      withdrawablePositions.find((position) => position.id === nextId)
        ?.withdrawableShares ?? ""
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await onSubmit(positionId, shares);
      setOpen(false);
    } catch {
      // App owns the toast. Keep the dialog open so the customer can correct it.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" disabled={!withdrawablePositions.length}>
            <ArrowUpFromLineIcon data-icon="inline-start" />
            Withdraw
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Withdraw from yield</DialogTitle>
            <DialogDescription>
              Redeem shares back to the managed devnet wallet. Northstar quotes
              a protection floor first when the strategy requires one.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="withdraw-position">Position</FieldLabel>
              <Select value={positionId} onValueChange={changePosition}>
                <SelectTrigger id="withdraw-position" className="w-full">
                  <SelectValue placeholder="Choose a position" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {withdrawablePositions.map((position) => (
                      <SelectItem key={position.id} value={position.id}>
                        {position.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="withdraw-shares">Shares</FieldLabel>
              <Input
                id="withdraw-shares"
                inputMode="decimal"
                value={shares}
                onChange={(event) => setShares(event.target.value)}
                required
              />
              <FieldDescription>
                Withdrawable: {selected?.withdrawableShares ?? "Not available"}
              </FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !positionId || !shares}>
              {busy ? (
                <LoaderCircleIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : null}
              Confirm withdrawal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
