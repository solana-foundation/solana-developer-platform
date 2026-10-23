import { isAuditedRampSettlementKind, type RampSettlementEvent } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { PaymentTransferStatus } from "@sdp/types/payments";
import {
  isRampTransferType,
  isTerminalRampTransferStatus,
  RAMP_TRANSFER_TRANSITIONS,
  type RampTransferTransitionId,
  type RampWebhookProcessResult,
} from "@sdp/types/payments";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import { asTransactionalClient, type DatabaseClient, getDb } from "@/db/client";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createSystemTransactionalPaymentsRepository } from "@/db/repositories/repository-factory";
import { logEvent } from "@/runtime/money-path-events";
import { createSystemAuditService, type SystemAuditLogEntry } from "@/services/audit.service";
import { rampAuditEntry } from "@/services/payments/ramp-audit";
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

function settlementTransition(
  transfer: PaymentTransferRow,
  event: Exclude<RampSettlementEvent, { kind: "ignore" }>
): RampTransferTransitionId {
  if (event.kind !== "failed" || event.provider !== "moonpay" || transfer.type !== "offramp") {
    return RAMP_SETTLEMENT_TRANSITION[event.kind];
  }
  // A deposit reported by either side still needs reconciliation after the
  // provider fails the sale; do not make it terminal.
  return event.onchain !== undefined ||
    transfer.signature !== null ||
    transfer.submission_started_at !== null
    ? "provider_settling"
    : "moonpay_sell_failed";
}

function settlementObservationFields(
  transfer: PaymentTransferRow,
  event: Exclude<RampSettlementEvent, { kind: "ignore" }>
): Pick<
  Parameters<PaymentsRepository["transitionRampTransfer"]>[0],
  "providerData" | "providerSettlementUnclaimed" | "providerSettlementMissingSignature"
> {
  const providerData: Record<string, unknown> = {};
  const receivedAmount = "receivedAmount" in event ? event.receivedAmount : undefined;
  const receivedCurrency = "receivedCurrency" in event ? event.receivedCurrency : undefined;
  const observation: Record<string, unknown> = {
    kind: event.kind,
    reference: event.reference,
  };
  if (event.providerObservedAt) observation.observedAt = event.providerObservedAt;
  if (event.onchain) observation.onchain = event.onchain;
  if (receivedAmount !== undefined) observation.receivedAmount = receivedAmount;
  if (receivedCurrency !== undefined) observation.receivedCurrency = receivedCurrency;
  if (event.refundAddress !== undefined) observation.refundAddress = event.refundAddress;
  providerData.observedDelivery = observation;
  // A new provider report supersedes the one SDP held as contradicted by the chain.
  providerData.deliveryMismatch = null;
  if (event.kind === "settled") {
    const settlement: Record<string, unknown> = { reference: event.reference };
    if (event.providerObservedAt) settlement.observedAt = event.providerObservedAt;
    if (event.onchain) settlement.onchain = event.onchain;
    if (event.receivedAmount !== undefined) settlement.receivedAmount = event.receivedAmount;
    if (event.receivedCurrency !== undefined) settlement.receivedCurrency = event.receivedCurrency;
    if (event.refundAddress !== undefined) settlement.refundAddress = event.refundAddress;
    providerData.providerSettlement = settlement;
    if (event.providerObservedAt !== undefined) return { providerData };
    if (event.onchain?.signature && transfer.type === "onramp") {
      return { providerData, providerSettlementMissingSignature: true };
    }
    return { providerData, providerSettlementUnclaimed: true };
  }
  // Stripe has no per-session observation time. An untimed event cannot
  // supersede an accepted settled claim while chain proof is pending.
  if (event.providerObservedAt === undefined) {
    providerData.providerSettlement = null;
    return { providerData, providerSettlementUnclaimed: true };
  }
  providerData.providerSettlement = null;
  return { providerData };
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
    transition: settlementTransition(transfer, event),
    updatedAt: new Date().toISOString(),
    ...settlementObservationFields(transfer, event),
  };
  if (event.providerObservedAt !== undefined) {
    update.providerObservation = {
      reference: event.reference,
      observedAt: event.providerObservedAt,
    };
  }
  if (event.onchain && transfer.type === "onramp" && transfer.signature === null) {
    update.signature = event.onchain.signature;
  }
  if ((event.kind === "failed" || event.kind === "expired") && event.error) {
    update.error = event.error;
  }
  if (event.kind === "failed" && transfer.type === "offramp") {
    update.providerData = { ...update.providerData, cryptoDeposit: null };
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

const displacedReferencesSchema = z.array(z.string());

/** The provider customer references a counterparty link has displaced; none when it lists none. */
function displacedReferences(metadata: Record<string, unknown>): readonly string[] {
  const references = displacedReferencesSchema.safeParse(metadata.mismatchedReferences);
  return references.success ? references.data : [];
}

/** Whether the rail a provider reports delivering is the transfer's own asset. */
function deliversTransferAsset(transfer: PaymentTransferRow, rail: CryptoRailId | null): boolean {
  if (rail === null) {
    return false;
  }
  return WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token)?.symbol === getCryptoRailAssetLabel(rail);
}

/** Where a provider event's work hands the audit record its transition owes. */
export type RecordRampAudit = (entry: SystemAuditLogEntry) => void;

/**
 * Runs a provider event's work in one transaction. A settled, failed or
 * expired event runs in the audit ledger's, so the transition the work
 * records commits with its audit row, or neither commits.
 */
export async function withRampSettlementTransaction<T>(
  env: Env,
  kind: RampSettlementEvent["kind"],
  work: (client: DatabaseClient, recordAudit: RecordRampAudit) => Promise<T>
): Promise<T> {
  if (!isAuditedRampSettlementKind(kind)) {
    return getDb(env).transaction((tx) => work(asTransactionalClient(tx), () => undefined));
  }
  return createSystemAuditService(env).logSystemWithin(async (client) => {
    // Held in an object: control flow does not follow assignments in a callback.
    const recorded: { entry: SystemAuditLogEntry | null } = { entry: null };
    const result = await work(client, (entry) => {
      recorded.entry = entry;
    });
    return { entry: recorded.entry, result };
  });
}

/** Runs a settlement's writes: in a transaction of their own, or in the caller's. */
type RampSettlementWrites = <T>(
  work: (client: DatabaseClient, recordAudit: RecordRampAudit) => Promise<T>
) => Promise<T>;

/**
 * Applies a provider settlement event in its own transaction. The checks read
 * first, outside it, so the audit ledger's lock covers only the writes.
 */
export function applyRampSettlementEvent(
  env: Env,
  environment: SdpEnvironment,
  event: RampSettlementEvent
): Promise<RampWebhookProcessResult & { applied: boolean }> {
  return settleRampEvent(environment, event, getDb(env), (work) =>
    withRampSettlementTransaction(env, event.kind, work)
  );
}

/**
 * Applies a provider settlement event inside the caller's transaction,
 * handing any audit record its transition owes to `recordAudit`.
 */
export function applyRampSettlementEventIn(
  environment: SdpEnvironment,
  event: RampSettlementEvent,
  client: DatabaseClient,
  recordAudit: RecordRampAudit
): Promise<RampWebhookProcessResult & { applied: boolean }> {
  return settleRampEvent(environment, event, client, (work) => work(client, recordAudit));
}

/**
 * Applies a provider settlement event to the transfer it references. The
 * transition is a compare-and-swap, so concurrent or redelivered events lose
 * the CAS instead of overwriting state.
 *
 * @param environment - Environment of the verified provider webhook.
 * @param event - The provider settlement event to apply.
 * @param db - Where the checks read: the root client, or the caller's transaction.
 * @param runWrites - Runs the transition and link writes, with the audit record
 * a settled, failed or expired transition owes.
 * @returns Whether the event produced a real transition; callers release
 * provider reservations only on a real one.
 */
async function settleRampEvent(
  environment: SdpEnvironment,
  event: RampSettlementEvent,
  db: DatabaseClient,
  runWrites: RampSettlementWrites
): Promise<RampWebhookProcessResult & { applied: boolean }> {
  if (event.kind === "ignore") {
    return { applied: false, outcome: "ignored" };
  }

  // Reconciliation key: the provider-issued transaction reference currently
  // bound to this row. A failed MoonPay attempt may release its reference for
  // retry; an event whose reference matches no row is never guessed at.
  const repo = createSystemTransactionalPaymentsRepository(db);
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
    return { applied: false, outcome: "unmatched" };
  }
  const transferEnvironment = await repo.getTransferProjectEnvironment({
    transferId: transfer.id,
    provider: event.provider,
  });
  if (transferEnvironment !== environment) {
    logEvent("error", {
      event: "sdp_api_ramp_settlement_environment_mismatch",
      flow: "ramp-settlement",
      provider: event.provider,
      provider_reference: event.reference,
      project_id: transfer.project_id,
      environment,
      transfer_environment: transferEnvironment,
    });
    return { applied: false, outcome: "refused", reason: "environment_mismatch" };
  }
  if (transfer.provider !== event.provider) {
    return { applied: false, outcome: "refused", reason: "provider_mismatch" };
  }
  if (!isRampTransferType(transfer.type)) {
    return { applied: false, outcome: "refused", reason: "transfer_type_mismatch" };
  }
  if (event.kind === "settled" && transfer.status === "canceled") {
    return { applied: false, outcome: "refused", reason: "settled_after_cancel" };
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
    return { applied: false, outcome: "refused", reason: "asset_mismatch" };
  }
  // Out-of-order or redelivered events must not regress a settled transfer
  // (e.g. a retried PENDING arriving after COMPLETED).
  if (isSettlementFinalStatus(transfer.status)) {
    return { applied: false, outcome: "ignored" };
  }

  const update = buildRampSettlementUpdate(transfer, event);

  // The status transition and the provider-customer link derive from one
  // provider event, so they land or roll back together — and an event whose
  // transition was ignored (lost race, out-of-order redelivery) has no
  // effects at all: no link write.
  const { updated, newlyMismatchedLink } = await runWrites(async (client, recordAudit) => {
    const updated =
      await createSystemTransactionalPaymentsRepository(client).transitionRampTransfer(update);
    if (updated !== null && isAuditedRampSettlementKind(event.kind)) {
      recordAudit(
        rampAuditEntry(event.kind === "settled" ? "settle" : "update", updated, {
          source: "provider",
          transition: update.transition,
          fromStatus: transfer.status,
          providerObservedAt: event.providerObservedAt ?? null,
          receivedAmount: event.kind === "settled" ? (event.receivedAmount ?? null) : null,
          receivedCurrency: event.kind === "settled" ? (event.receivedCurrency ?? null) : null,
        })
      );
    }
    if (
      updated !== null &&
      event.providerCustomerId !== undefined &&
      transfer.counterparty_id !== null
    ) {
      const accounts = createPostgresCounterpartyProviderAccountsRepository(client);
      const linkScope = {
        organizationId: transfer.organization_id,
        projectId: transfer.project_id,
        counterpartyId: transfer.counterparty_id,
        provider: event.provider,
      };
      const prior = await accounts.getProviderAccount(linkScope);
      const link = await accounts.upsertProviderAccount({
        ...linkScope,
        providerCustomerReference: event.providerCustomerId,
      });
      // The link keeps every displaced reference, so only a first sighting is news.
      const newlyMismatched =
        link.provider_customer_reference !== event.providerCustomerId &&
        !(prior !== null && displacedReferences(prior.metadata).includes(event.providerCustomerId));
      return { updated, newlyMismatchedLink: newlyMismatched ? link : null };
    }
    return { updated, newlyMismatchedLink: null };
  });
  const applied = updated !== null;

  if (!applied && event.kind === "settled") {
    const current = await repo.getTransferById({
      transferId: transfer.id,
      organizationId: transfer.organization_id,
      projectId: transfer.project_id,
    });
    if (current?.status === "canceled") {
      return { applied: false, outcome: "refused", reason: "settled_after_cancel" };
    }
  }

  // First-write-wins: the event reported a different provider customer than the
  // counterparty's canonical link. The displaced reference is preserved in the
  // link row's metadata; surface it for operators the first time it appears.
  if (newlyMismatchedLink !== null) {
    logEvent("warn", {
      event: "sdp_api_counterparty_provider_reference_mismatch",
      flow: "ramp-settlement",
      organization_id: transfer.organization_id,
      project_id: transfer.project_id,
      transfer_id: transfer.id,
      counterparty_id: transfer.counterparty_id,
      provider: event.provider,
      canonical_reference: newlyMismatchedLink.provider_customer_reference,
      mismatched_reference: event.providerCustomerId,
    });
  }
  logEvent("info", {
    event: applied ? "sdp_api_ramp_settlement_applied" : "sdp_api_ramp_settlement_ignored",
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
  return { applied, outcome: applied ? "applied" : "ignored" };
}
