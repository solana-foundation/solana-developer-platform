import type { RampSettlementEvent } from "@sdp/payments/ramps";
import { asTransactionalClient, getDb } from "@/db";
import type {
  PaymentsRepository,
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories";
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

// awaiting_payment self-transition is allowed: a provider may issue a NEW
// deposit wallet while still awaiting payment (MoonPay does on sale
// re-confirmation), and the refreshed cryptoDeposit must land.
const ALLOWED_RAMP_SETTLEMENT_SOURCE_STATUSES = {
  awaiting_payment: ["pending", "awaiting_payment", "expired"],
  settling: ["pending", "awaiting_payment", "processing", "confirmed", "finalized", "expired"],
  settled: [
    "pending",
    "awaiting_payment",
    "processing",
    "confirmed",
    "finalized",
    "settling",
    "expired",
  ],
  failed: [
    "pending",
    "awaiting_payment",
    "processing",
    "confirmed",
    "finalized",
    "settling",
    "expired",
  ],
  // `settling` is deliberately absent: a stale redelivered EXPIRED event must
  // not regress a transfer another event already revived into processing.
  expired: ["pending", "awaiting_payment"],
} as const satisfies Record<
  Exclude<RampSettlementEvent["kind"], "ignore">,
  readonly PaymentTransferStatus[]
>;

function isTerminalRampTransferStatus(status: PaymentTransferStatus): boolean {
  return (TERMINAL_RAMP_TRANSFER_STATUSES as readonly PaymentTransferStatus[]).includes(status);
}

/**
 * Builds the guarded transfer update one settlement event produces.
 *
 * @param transfer - The matched ramp transfer row.
 * @param event - The provider settlement event.
 * @returns The guarded status update to apply.
 */
function buildRampSettlementUpdate(
  transfer: PaymentTransferRow,
  event: Exclude<RampSettlementEvent, { kind: "ignore" }>
): Parameters<PaymentsRepository["updateTransferStatusGuarded"]>[0] {
  const update: Parameters<PaymentsRepository["updateTransferStatusGuarded"]>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ALLOWED_RAMP_SETTLEMENT_SOURCE_STATUSES[event.kind],
    toStatus: RAMP_SETTLEMENT_STATUS[event.kind],
    updatedAt: new Date().toISOString(),
  };
  if (event.onchain) {
    if (transfer.signature === null) {
      update.signature = event.onchain.signature;
    }
    update.sourceAddress = event.onchain.sourceAddress;
    update.destinationAddress = event.onchain.destinationAddress;
    update.amount = event.onchain.amount;
  }
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
  // The row is created with the provider's quote/session reference; the first
  // event carrying the provider transaction id promotes provider_reference to it.
  if (
    event.transactionReference !== undefined &&
    event.transactionReference !== transfer.provider_reference
  ) {
    update.providerReference = event.transactionReference;
  }
  // The provider's deposit instruction lets the dashboard send the crypto on
  // the customer's behalf; each event replaces the previous instruction, and
  // `null` withdraws it (requote pending) until the provider issues a new one.
  if (event.kind === "awaiting_payment" && event.cryptoDeposit !== undefined) {
    update.providerData = { cryptoDeposit: event.cryptoDeposit };
  }
  // Economics are captured only here, at the terminal settlement webhook — they are not
  // backfilled for transfers that settled before this shipped.
  if (
    (event.kind === "settled" || event.kind === "failed" || event.kind === "expired") &&
    event.settlement
  ) {
    update.providerData = { settlement: event.settlement };
  }
  return update;
}

/**
 * Verifies every event reference against everything the transfer row knows.
 * Rows persisted with a stored quote reference must match the event's quote
 * reference on every event for the row's whole life, and once the row is
 * promoted to the provider transaction id, the event's transaction reference
 * must match it exactly. Rows that predate the stored quote reference fall
 * back to matching provider_reference against either event reference.
 *
 * @param transfer - The correlated transfer row.
 * @param event - The provider settlement event.
 * @returns True when every checkable reference on the event agrees with the row.
 */
function corroboratesTransferReferences(
  transfer: PaymentTransferRow,
  event: Exclude<RampSettlementEvent, { kind: "ignore" }>
): boolean {
  const storedQuoteReference = transfer.provider_data.quoteReference;
  if (typeof storedQuoteReference !== "string") {
    return (
      transfer.provider_reference === event.reference ||
      transfer.provider_reference === event.transactionReference
    );
  }
  if (event.reference !== storedQuoteReference) {
    return false;
  }
  const promoted = transfer.provider_reference !== storedQuoteReference;
  return !promoted || transfer.provider_reference === event.transactionReference;
}

/**
 * Correlates one settlement event to the single transfer every supplied
 * identifier agrees on. Identifiers are never ignored: a supplied transfer id
 * that resolves to nothing refuses the event, identifiers resolving to
 * different transfers refuse the event, and every checkable reference on the
 * survivor must agree (see corroboratesTransferReferences). The transaction
 * reference is allowed to resolve to nothing only because it cannot exist
 * before its own first event promotes it onto the row — there the
 * provider-signed quote reference is the binding authority.
 *
 * @param env - Worker environment for database access.
 * @param event - The provider settlement event.
 * @returns The uniquely correlated transfer, or null when the event must not settle anything.
 */
async function correlateRampSettlementTransfer(
  env: Env,
  event: Exclude<RampSettlementEvent, { kind: "ignore" }>
): Promise<PaymentTransferRow | null> {
  const repo = createSystemPaymentsRepository(env);
  const transferIdMatch = event.transferId
    ? await repo.getTransferById({ transferId: event.transferId })
    : null;
  if (event.transferId !== undefined && transferIdMatch === null) {
    logEvent("warn", {
      event: "sdp_api_ramp_settlement_unresolved_transfer_id",
      flow: "ramp-settlement",
      provider: event.provider,
      event_transfer_id: event.transferId,
      event_quote_id: event.reference,
      event_transaction_id: event.transactionReference,
    });
    return null;
  }
  const transactionMatch = event.transactionReference
    ? await repo.getTransferByProviderReference({
        provider: event.provider,
        providerReference: event.transactionReference,
      })
    : null;
  const referenceMatch = await repo.getTransferByProviderReference({
    provider: event.provider,
    providerReference: event.reference,
  });
  const matches = [transferIdMatch, transactionMatch, referenceMatch].filter(
    (candidate) => candidate !== null
  );
  const matchedIds = new Set(matches.map((candidate) => candidate.id));
  if (matchedIds.size > 1) {
    logEvent("warn", {
      event: "sdp_api_ramp_settlement_conflicting_identifiers",
      flow: "ramp-settlement",
      provider: event.provider,
      matched_transfer_ids: [...matchedIds],
      event_transfer_id: event.transferId,
      event_quote_id: event.reference,
      event_transaction_id: event.transactionReference,
    });
    return null;
  }
  if (matches.length === 0) {
    logEvent("info", {
      event: "sdp_api_ramp_settlement_unmatched",
      flow: "ramp-settlement",
      provider: event.provider,
      event_transfer_id: event.transferId,
      event_quote_id: event.reference,
      event_transaction_id: event.transactionReference,
    });
    return null;
  }
  const transfer = matches[0];
  if (!corroboratesTransferReferences(transfer, event)) {
    logEvent("warn", {
      event: "sdp_api_ramp_settlement_reference_mismatch",
      flow: "ramp-settlement",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      provider: event.provider,
      transfer_provider_reference: transfer.provider_reference,
      event_quote_id: event.reference,
      event_transaction_id: event.transactionReference,
    });
    return null;
  }
  if (transfer.provider !== event.provider) {
    logEvent("warn", {
      event: "sdp_api_ramp_settlement_provider_mismatch",
      flow: "ramp-settlement",
      transfer_id: transfer.id,
      transfer_provider: transfer.provider,
      provider: event.provider,
    });
    return null;
  }
  return transfer;
}

export async function applyRampSettlementEvent(env: Env, event: RampSettlementEvent) {
  if (event.kind === "ignore") {
    return;
  }

  const transfer = await correlateRampSettlementTransfer(env, event);
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

  const update = buildRampSettlementUpdate(transfer, event);

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

  if (applied) {
    logEvent("info", {
      event: "sdp_api_ramp_settlement_applied",
      flow: "ramp-settlement",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      provider: transfer.provider,
      provider_reference: event.reference,
      from_status: transfer.status,
      to_status: RAMP_SETTLEMENT_STATUS[event.kind],
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
