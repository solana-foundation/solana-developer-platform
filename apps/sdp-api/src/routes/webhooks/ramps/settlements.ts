import type { Context } from "hono";
import type { PaymentTransferStatus, UpdatePaymentTransferInput } from "@/db/repositories";
import { createPaymentsRepository, isRampTransferType } from "@/db/repositories";
import type { RampSettlementEvent } from "@/lib/ramps";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

const RAMP_SETTLEMENT_STATUS = {
  awaiting_payment: "awaiting_payment",
  settling: "settling",
  settled: "completed",
  failed: "failed",
  expired: "expired",
} as const satisfies Record<Exclude<RampSettlementEvent["kind"], "ignore">, PaymentTransferStatus>;

const TERMINAL_RAMP_TRANSFER_STATUSES = [
  "completed",
  "failed",
  "expired",
] as const satisfies readonly PaymentTransferStatus[];

function isTerminalRampTransferStatus(status: PaymentTransferStatus): boolean {
  return (TERMINAL_RAMP_TRANSFER_STATUSES as readonly PaymentTransferStatus[]).includes(status);
}

export async function applyRampSettlementEvent(c: AppContext, event: RampSettlementEvent) {
  if (event.kind === "ignore") {
    return;
  }

  const repo = createPaymentsRepository(c.env);
  const transfer = await repo.getTransferByProviderReference({
    provider: event.provider,
    providerReference: event.reference,
  });
  if (!transfer) {
    return;
  }
  if (!isRampTransferType(transfer.type)) {
    return;
  }
  // Out-of-order or redelivered events must not regress a settled transfer
  // (e.g. a retried PENDING arriving after COMPLETED).
  if (isTerminalRampTransferStatus(transfer.status)) {
    return;
  }

  const update: UpdatePaymentTransferInput = {
    transferId: transfer.id,
    status: RAMP_SETTLEMENT_STATUS[event.kind],
    updatedAt: new Date().toISOString(),
  };
  // For off-ramp the received side is the fiat payout; for on-ramp it is the
  // crypto leg, which the transfer row already records as its amount.
  if (event.kind === "settled" && event.receivedAmount && transfer.type === "offramp") {
    update.fiatAmount = event.receivedAmount;
  }
  if (event.kind === "failed" && event.error) {
    update.error = event.error;
  }
  if (event.kind === "expired" && event.error) {
    update.error = event.error;
  }

  await repo.updateTransfer(update);
}
