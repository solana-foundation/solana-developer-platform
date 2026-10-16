import type { RampSettlementEvent } from "@sdp/payments/ramps";
import {
  type CryptoRailId,
  getCryptoRailAssetLabel,
  isTerminalRampTransferStatus,
  RAMP_TRANSFER_TRANSITIONS,
  type RampTransferTransitionId,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
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
import type { Env } from "@/types/env";

// Named, not derived from the event kind, so a renamed transition fails typecheck here.
const RAMP_SETTLEMENT_TRANSITION = {
  awaiting_payment: "provider_awaiting_payment",
  settling: "provider_settling",
  settled: "provider_settled",
  failed: "provider_failed",
  expired: "provider_expired",
} as const satisfies Record<
  Exclude<RampSettlementEvent["kind"], "ignore">,
  RampTransferTransitionId
>;

// `expired` is carved out of the shared terminal set: it is derived from provider
// ABSENCE (an abandoned checkout the provider never saw), and a provider event
// proving activity must be able to revive it — signed widget URLs do not expire,
// so a customer can complete checkout after the abandonment horizon.
// RAMP_TRANSFER_TRANSITIONS refuses these sources too; this returns before any write.
function isSettlementFinalStatus(status: PaymentTransferStatus): boolean {
  return status !== "expired" && isTerminalRampTransferStatus(status);
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
): Parameters<PaymentsRepository["transitionRampTransfer"]>[0] {
  const update: Parameters<PaymentsRepository["transitionRampTransfer"]>[0] = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    transition: RAMP_SETTLEMENT_TRANSITION[event.kind],
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
  // Record the actual amount the provider reports: for `settled` the fiat
  // payout (off-ramp) or delivered crypto (on-ramp); for `settling` an on-ramp
  // pay-in observed on the funding wallet writes the fiat the bank delivered.
  if (event.kind === "settling" || event.kind === "settled") {
    if (event.receivedAmount !== undefined) {
      if (event.kind === "settled" ? transfer.type === "offramp" : transfer.type === "onramp") {
        update.fiatAmount = event.receivedAmount;
      } else {
        update.amount = event.receivedAmount;
      }
    }
  }
  if ((event.kind === "failed" || event.kind === "expired") && event.error) {
    update.error = event.error;
  }
  // The provider's deposit instruction lets the dashboard send the crypto on
  // the customer's behalf; each event replaces the previous instruction, and
  // `null` withdraws it (requote pending) until the provider issues a new one.
  if (event.kind === "awaiting_payment" && event.cryptoDeposit !== undefined) {
    update.providerData = { ...update.providerData, cryptoDeposit: event.cryptoDeposit };
  }
  // Economics are captured only here, at the terminal settlement webhook — they are not
  // backfilled for transfers that settled before this shipped.
  if (
    (event.kind === "settled" || event.kind === "failed" || event.kind === "expired") &&
    event.settlement
  ) {
    update.providerData = { ...update.providerData, settlement: event.settlement };
  }
  return update;
}

/** Whether the rail a provider reports delivering is the transfer's own asset. */
function deliversTransferAsset(transfer: PaymentTransferRow, rail: CryptoRailId | null): boolean {
  if (rail === null) {
    return false;
  }
  return WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token)?.symbol === getCryptoRailAssetLabel(rail);
}

/**
 * Applies a provider settlement event to the transfer it references. The
 * transition is a compare-and-swap, so concurrent or redelivered events lose
 * the CAS instead of overwriting state.
 *
 * @param env - Process environment used for repository access.
 * @param event - The provider settlement event to apply.
 * @returns Whether the event produced a real transition; callers release
 * provider reservations only on a real one.
 */
export async function applyRampSettlementEvent(
  env: Env,
  event: RampSettlementEvent
): Promise<{ applied: boolean }> {
  if (event.kind === "ignore") {
    return { applied: false };
  }

  // Reconciliation key: the provider-issued quote/session reference the row
  // was created with. provider_reference is never rewritten, so the lookup is
  // exact for the row's whole life; an event whose reference matches no row
  // is acknowledged and logged, never guessed at.
  const repo = createSystemPaymentsRepository(env);
  const transfer = await repo.getTransferByProviderReference({
    provider: event.provider,
    providerReference: event.reference,
  });
  if (!transfer) {
    logEvent("info", {
      event: "sdp_api_ramp_settlement_unmatched",
      flow: "ramp-settlement",
      provider: event.provider,
      provider_reference: event.reference,
    });
    return { applied: false };
  }
  if (transfer.provider !== event.provider) {
    return { applied: false };
  }
  if (!isRampTransferType(transfer.type)) {
    return { applied: false };
  }
  // Out-of-order or redelivered events must not regress a settled transfer
  // (e.g. a retried PENDING arriving after COMPLETED).
  if (isSettlementFinalStatus(transfer.status)) {
    return { applied: false };
  }
  // A lock the provider did not enforce must not write another asset's amount
  // onto the row, so a delivery the provider reports must be the transfer's asset.
  if (
    event.kind === "settled" &&
    event.deliveredAssetRail !== undefined &&
    !deliversTransferAsset(transfer, event.deliveredAssetRail)
  ) {
    logEvent("error", {
      event: "sdp_api_ramp_settlement_asset_mismatch",
      flow: "ramp-settlement",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      provider: transfer.provider,
      provider_reference: event.reference,
      delivered_asset_rail: event.deliveredAssetRail,
      transfer_token: transfer.token,
    });
    return { applied: false };
  }

  const update = buildRampSettlementUpdate(transfer, event);

  // The status transition and the provider-customer link derive from one
  // provider event, so they land or roll back together — and an event whose
  // transition was refused (lost race, out-of-order redelivery) has no
  // effects at all: no link write.
  const { applied, linkedReference } = await getDb(env).transaction(async (tx) => {
    const client = asTransactionalClient(tx);
    const updated =
      await createSystemTransactionalPaymentsRepository(client).transitionRampTransfer(update);
    if (
      updated !== null &&
      event.providerCustomerId !== undefined &&
      transfer.counterparty_id !== null
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

  // Refused covers both an illegal source status and a lost race: the CAS
  // cannot tell them apart, and neither wrote anything.
  logEvent("info", {
    event: applied ? "sdp_api_ramp_settlement_applied" : "sdp_api_ramp_settlement_refused",
    flow: "ramp-settlement",
    organization_id: transfer.organization_id,
    project_id: transfer.project_id,
    transfer_id: transfer.id,
    provider: transfer.provider,
    provider_reference: event.reference,
    transition: update.transition,
    from_status: transfer.status,
    to_status: RAMP_TRANSFER_TRANSITIONS[update.transition].to,
  });
  return { applied };
}
