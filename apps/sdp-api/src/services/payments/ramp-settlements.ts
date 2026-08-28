import type { RampSettlementEvent } from "@sdp/payments/ramps";
import { asTransactionalClient, getDb } from "@/db";
import type { PaymentTransferStatus } from "@/db/repositories";
import {
  createPostgresCounterpartyProviderAccountsRepository,
  createSystemPaymentsRepository,
  createSystemTransactionalPaymentsRepository,
  isRampTransferType,
} from "@/db/repositories";
import { logEvent } from "@/runtime/money-path-events";
import { emitRampSettled } from "@/services/workflows/payment-events";
import type { Env } from "@/types/env";

const RAMP_SETTLEMENT_STATUS = {
  awaiting_payment: "awaiting_payment",
  settling: "settling",
  settled: "completed",
  failed: "failed",
  expired: "expired",
} as const satisfies Record<Exclude<RampSettlementEvent["kind"], "ignore">, PaymentTransferStatus>;

// `expired` is deliberately absent: it is derived from provider ABSENCE (an
// abandoned checkout the provider never saw), and a provider event proving
// activity must be able to revive it — signed widget URLs do not expire, so a
// customer can complete checkout after the abandonment horizon.
const TERMINAL_RAMP_TRANSFER_STATUSES = [
  "completed",
  "failed",
  "canceled",
] as const satisfies readonly PaymentTransferStatus[];

const ALLOWED_RAMP_SETTLEMENT_SOURCE_STATUSES = {
  awaiting_payment: ["pending", "expired"],
  settling: ["pending", "awaiting_payment", "expired"],
  settled: ["pending", "awaiting_payment", "settling", "expired"],
  failed: ["pending", "awaiting_payment", "settling", "expired"],
  expired: ["pending", "awaiting_payment", "settling"],
} as const satisfies Record<
  Exclude<RampSettlementEvent["kind"], "ignore">,
  readonly PaymentTransferStatus[]
>;

function isTerminalRampTransferStatus(status: PaymentTransferStatus): boolean {
  return (TERMINAL_RAMP_TRANSFER_STATUSES as readonly PaymentTransferStatus[]).includes(status);
}

export async function applyRampSettlementEvent(env: Env, event: RampSettlementEvent) {
  if (event.kind === "ignore") {
    return;
  }

  const repo = createSystemPaymentsRepository(env);
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

  // The status transition and the provider-customer link derive from one
  // provider event, so they land or roll back together — and an event whose
  // transition was refused (lost race, out-of-order redelivery) has no
  // effects at all: no link write, no workflow trigger.
  const { applied, linkedReference } = await getDb(env).transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const updated =
      await createSystemTransactionalPaymentsRepository(client).updateTransferStatusGuarded(update);
    if (
      updated !== null &&
      event.providerCustomerId !== undefined &&
      transfer.counterparty_id !== null &&
      transfer.project_id !== null
    ) {
      const link = await createPostgresCounterpartyProviderAccountsRepository(
        client
      ).upsertProviderAccount({
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
        counterpartyId: transfer.counterparty_id,
        provider: event.provider,
        providerCustomerReference: event.providerCustomerId,
      });
      return { applied: true, linkedReference: link.provider_customer_reference };
    }
    return { applied: updated !== null, linkedReference: null };
  });

  // First-write-wins: the event reported a different provider customer than the
  // counterparty's canonical link. The displaced reference is preserved in the
  // link row's metadata; surface it for operators.
  if (
    linkedReference !== null &&
    event.providerCustomerId !== undefined &&
    linkedReference !== event.providerCustomerId
  ) {
    logEvent("warn", {
      event: "sdp_api_counterparty_provider_reference_mismatch",
      flow: "ramp-settlement",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      counterparty_id: transfer.counterparty_id,
      provider: event.provider,
      canonical_reference: linkedReference,
      mismatched_reference: event.providerCustomerId,
    });
  }

  // Workflow trigger seam: a settled ramp fires onramp_settled / offramp_settled —
  // only when the settled transition actually landed. A settled event that lost a
  // race to another terminal event must not fire settlement workflows for a
  // transfer whose persisted state is not settled.
  if (applied && event.kind === "settled" && transfer.project_id) {
    emitRampSettled(env, {
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
