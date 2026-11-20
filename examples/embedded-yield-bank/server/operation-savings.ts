import "server-only";

import {
  type EarnOperation,
  isOperationActive,
} from "../src/lib/core-operation";
import type { TokenBalance, YieldPosition } from "../src/types";
import { type SavingsLedgerEntry, summarizeSavings } from "./savings";

/** Historical exits keep their strategy after the live holding closes. */
export function operationsForSavingsStrategy(
  operations: readonly EarnOperation[],
  strategyId: string,
  positions: readonly Pick<YieldPosition, "id">[]
): EarnOperation[] {
  const positionIds = new Set(positions.map((position) => position.id));
  for (const operation of operations) {
    if (
      operation.result &&
      (operation.result.strategyId === strategyId ||
        (operation.intent.kind === "earn.deposit" &&
          operation.intent.strategyId === strategyId))
    )
      positionIds.add(operation.result.positionId);
  }
  return operations.filter((operation) =>
    operation.intent.kind === "earn.deposit"
      ? operation.intent.strategyId === strategyId
      : operation.result?.strategyId === strategyId ||
        positionIds.has(operation.intent.positionId)
  );
}

/** Only completed inputs and verified delivered payouts enter earnings. */
export function summarizeSavingsOperations(
  checking: Pick<TokenBalance, "amount">,
  position: YieldPosition | null,
  operations: readonly EarnOperation[],
  tokenMint: string
) {
  // Returning strategy shares changes control, not cash flow or earnings.
  const cashFlows = operations.filter(
    (operation) => operation.result?.settlementOutcome !== "recovered"
  );
  const entries: SavingsLedgerEntry[] = [];
  let pendingWithdrawal = false;
  for (const operation of cashFlows) {
    // A cancelled exit returns its original asset; it is never an earnings payout.
    if (operation.status === "cancelled") continue;
    const active = isOperationActive(operation);
    if (
      active &&
      operation.kind === "earn.withdraw" &&
      operation.resourceRef !== null
    )
      pendingWithdrawal = true;
    const amount =
      operation.intent.kind === "earn.deposit"
        ? operation.intent.amount
        : operation.result?.settlementOutcome === "delivered"
          ? operation.result.settledAmount
          : null;
    entries.push({
      direction: operation.kind === "earn.deposit" ? "deposit" : "withdrawal",
      status:
        operation.status === "completed"
          ? "completed"
          : operation.status === "failed"
            ? "failed"
            : "pending",
      tokenAmount: amount?.mint === tokenMint ? amount.value : null,
    });
  }
  const summary = summarizeSavings(
    checking,
    position,
    entries,
    pendingWithdrawal
  );
  const deposits = new Set(
    cashFlows.flatMap((operation) =>
      operation.kind === "earn.deposit" &&
      operation.status === "completed" &&
      operation.result
        ? [operation.result.positionId]
        : []
    )
  );
  // A first exit from an imported holding has no acquisition cost to subtract.
  if (
    cashFlows.some(
      (operation) =>
        operation.intent.kind === "earn.withdraw" &&
        operation.status === "completed" &&
        !deposits.has(operation.intent.positionId)
    )
  )
    summary.earned = undefined;
  return summary;
}
