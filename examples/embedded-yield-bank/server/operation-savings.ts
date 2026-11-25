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

/** Where an operation stands in the savings ledger; cancelled ones never reach it. */
function ledgerStatus(
  status: EarnOperation["status"]
): SavingsLedgerEntry["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "prepared":
    case "queued":
    case "awaiting_signature":
    case "submitted":
    case "settling":
    case "cancelled":
      return "pending";
    default: {
      const unknownStatus: never = status;
      throw new Error(`Unknown operation status: ${unknownStatus}`);
    }
  }
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
    // Only observed amounts enter earnings. A deposit's intent is a ceiling
    // (Kamino can debit less), so a completed one counts its settled amount, and
    // stays unknown until SDP observes it.
    const amount =
      operation.intent.kind === "earn.deposit" ||
      operation.result?.settlementOutcome === "delivered"
        ? (operation.result?.settledAmount ?? null)
        : null;
    entries.push({
      direction: operation.kind === "earn.deposit" ? "deposit" : "withdrawal",
      status: ledgerStatus(operation.status),
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
