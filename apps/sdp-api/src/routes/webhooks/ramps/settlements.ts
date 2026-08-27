import type { RampSettlementEvent } from "@sdp/payments/ramps";
import type { RampTransferSettlement } from "@sdp/types";
import type { Context } from "hono";
import type { PaymentTransferStatus } from "@/db/repositories";
import { createSystemPaymentsRepository, isRampTransferType } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { emitRampSettled } from "@/services/workflows/payment-events";
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
  "canceled",
] as const satisfies readonly PaymentTransferStatus[];

const ALLOWED_RAMP_SETTLEMENT_SOURCE_STATUSES = {
  awaiting_payment: ["pending"],
  settling: ["pending", "awaiting_payment"],
  settled: ["pending", "awaiting_payment", "settling"],
  failed: ["pending", "awaiting_payment", "settling"],
  expired: ["pending", "awaiting_payment", "settling"],
} as const satisfies Record<
  Exclude<RampSettlementEvent["kind"], "ignore">,
  readonly PaymentTransferStatus[]
>;

function isTerminalRampTransferStatus(status: PaymentTransferStatus): boolean {
  return (TERMINAL_RAMP_TRANSFER_STATUSES as readonly PaymentTransferStatus[]).includes(status);
}

/**
 * Pull an on-chain signature out of a provider's settlement payload, where the provider
 * reports one we can trust to be a Solana signature (#559).
 *
 * Deliberately narrow. Coinbase's `txHash` on a successful on-ramp is a Solana signature.
 * MoonPay reports `cryptoTransactionId`, whose format is not established, and Lightspark
 * reports no chain identifier at all, so neither is collected here.
 *
 * Collecting a signature is not the same as advertising a guarantee. Nothing recorded here
 * changes what a transfer reports until the verifier proves the transaction moved the expected
 * amount to the expected wallet, and until the pair is listed in RAMP_ONCHAIN_VERIFIED_PAIRS.
 * The cost of collecting a wrong value is bounded: the verifier records "transaction not found"
 * and the attempt cap stops it.
 */
function settlementSignatureFrom(settlement: RampTransferSettlement | undefined): string | null {
  return settlement?.provider === "coinbase" ? (settlement.txHash ?? null) : null;
}

export async function applyRampSettlementEvent(c: AppContext, event: RampSettlementEvent) {
  if (event.kind === "ignore") {
    return;
  }

  const repo = createSystemPaymentsRepository(c.env);
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

  const update: Parameters<typeof repo.updateTransferStatusGuarded>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ALLOWED_RAMP_SETTLEMENT_SOURCE_STATUSES[event.kind],
    toStatus: RAMP_SETTLEMENT_STATUS[event.kind],
    updatedAt: new Date().toISOString(),
  };
  // Record the actual settled amount the provider reports: the fiat payout for
  // off-ramp, the delivered crypto for on-ramp.
  if (event.kind === "settled" && event.receivedAmount) {
    if (transfer.type === "offramp") {
      update.fiatAmount = event.receivedAmount;
    } else {
      update.amount = event.receivedAmount;
    }
  }
  if ((event.kind === "failed" || event.kind === "expired") && event.error) {
    update.error = event.error;
  }
  // Economics are captured only here, at the terminal settlement webhook — they are not
  // backfilled for transfers that settled before this shipped.
  if (
    (event.kind === "settled" || event.kind === "failed" || event.kind === "expired") &&
    event.settlement
  ) {
    update.providerData = { settlement: event.settlement };
  }

  // Record the provider's claimed signature so the verifier can check it against the chain.
  // Storing it does not make the transfer verified: settlement_verified_at stays null until
  // the transaction is proven to have moved the expected amount to the expected wallet.
  if (event.kind === "settled") {
    const settlementSignature = settlementSignatureFrom(event.settlement);
    if (settlementSignature) {
      update.settlementSignature = settlementSignature;
    } else if (event.settlement) {
      // #559 W4. We have no confirmed chain identifier for this provider, and the question is
      // whether one is present at all. Logging the payload's KEY NAMES, never its values, turns
      // the next sandbox settlement into the answer without anyone capturing payloads by hand.
      // Values are withheld deliberately: they carry amounts and provider references.
      getLogger().info({
        event: "ramp_settlement_payload_shape",
        provider: event.settlement.provider,
        keys: Object.keys(event.settlement).sort(),
      });
    }
  }

  await repo.updateTransferStatusGuarded(update);

  // Workflow trigger seam: a settled ramp fires onramp_settled / offramp_settled.
  // Rules are project-scoped, so a transfer without a project has nothing to match.
  if (event.kind === "settled" && transfer.project_id) {
    emitRampSettled(c, {
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
      direction: transfer.type === "offramp" ? "offramp" : "onramp",
      transferId: transfer.id,
      provider: transfer.provider,
      counterpartyId: transfer.counterparty_id,
      amount: event.receivedAmount ?? null,
      fiatCurrency: transfer.fiat_currency,
      cryptoToken: transfer.token,
    });
  }
}
