import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { MuralWebhookEvent } from "@sdp/payments/ramps/providers/mural/client";
import type { MuralKycStatus } from "@sdp/payments/ramps/providers/mural/provider-data";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { KycStatus, SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import {
  createKycWalletsRepository,
  createSystemCounterpartiesRepository,
  createSystemPaymentsRepository,
  type PaymentsRepository,
  type PaymentTransferRow,
  type PaymentTransferStatus,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { Env } from "@/types/env";
import type { WebhookProcessor } from "./processor";
import { DeferrableRampWebhookError } from "./processor";

const MURAL_DELIVERY_ID_FIELD = "__sdpDeliveryId";

type MuralProcessorEvent =
  | Exclude<MuralWebhookEvent, { kind: "account_credited" }>
  | (Extract<MuralWebhookEvent, { kind: "account_credited" }> & { deliveryId: string });

async function muralDeliveryId(timestamp: string, rawBody: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readMuralData(transfer: PaymentTransferRow): Record<string, unknown> {
  const mural = transfer.provider_data.mural;
  if (!mural || typeof mural !== "object" || Array.isArray(mural)) {
    return {};
  }
  return mural as Record<string, unknown>;
}

// Map Mural's provider KYC status onto SDP's normalized status. Mural is the first
// writer into the SDP-owned kyc_wallets.kyc_status; other providers plug in the same way.
// 'errored' is a provider-side processing failure, NOT a compliance decision — mapping
// it to 'rejected' would fire kyc_rejected rules (allowlist_remove / freeze) against a
// holder whose verification was never actually declined.
function mapMuralKycStatusToSdp(status: MuralKycStatus): KycStatus {
  switch (status) {
    case "approved":
      return "verified";
    case "rejected":
      return "rejected";
    case "pending":
      return "pending";
    default:
      return "unverified";
  }
}

function readMuralWebhookPublicKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  const publicKey =
    environment === "sandbox"
      ? env.MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY?.trim()
      : env.MURAL_PAY_WEBHOOK_PUBLIC_KEY?.trim();
  if (!publicKey) {
    throw providerNotConfigured(
      environment === "sandbox"
        ? "Mural sandbox webhook public key is not configured (MURAL_PAY_SANDBOX_WEBHOOK_PUBLIC_KEY)."
        : "Mural webhook public key is not configured (MURAL_PAY_WEBHOOK_PUBLIC_KEY)."
    );
  }
  return publicKey;
}

async function findMuralOnrampTransfer(
  env: Env,
  payments: PaymentsRepository,
  counterparty: CounterpartyRow,
  accountId: string,
  statuses: PaymentTransferStatus[]
): Promise<PaymentTransferRow | undefined> {
  const matches = await getDb(env)
    .prepare(
      `SELECT id
       FROM payment_transfers
       WHERE organization_id = ?
         AND project_id IS NOT DISTINCT FROM ?
         AND counterparty_id = ?
         AND provider = 'mural'
         AND type = 'onramp'
         AND status = ANY(?)
         AND provider_data->'mural'->>'accountId' = ?
       ORDER BY id
       LIMIT 2`
    )
    .bind(
      counterparty.organization_id,
      counterparty.project_id,
      counterparty.id,
      statuses,
      accountId
    )
    .all<{ id: string }>();
  // Mural's account_credited event has no quote/transfer reference. Refuse to
  // guess when multiple live quotes share an account; a single signed event
  // must never settle more than one transfer through replay or ordering.
  if (matches.results.length !== 1) {
    return undefined;
  }
  const match = matches.results[0];
  if (!match) {
    return undefined;
  }
  return (
    (await payments.getTransferById({
      transferId: match.id,
      organizationId: counterparty.organization_id,
      projectId: counterparty.project_id,
    })) ?? undefined
  );
}

type MuralAccountCreditClaim = "completed" | "blocked" | "already_claimed";

/**
 * Claims an awaiting on-ramp transfer for an account credit in a single atomic
 * statement, with the compliance gate inside the claim's WHERE clause: a
 * rejection or review error that commits while the credit is in flight is
 * honored by the very write that would settle money, so the settlement can
 * never slip past a decision that lands concurrently with it.
 *
 * The gate reads the counterparty under a row lock (`FOR UPDATE`): the
 * lifecycle handler writes a compliance decision to that same row, so the
 * claim cannot snapshot an `approved` state and complete while a rejection
 * commits — it either waits on the lock and then sees the decision (blocked),
 * or wins the lock and orders the credit strictly before the rejection. The
 * two applies therefore always serialize into a state a sequential replay of
 * the same signed events would also produce.
 */
export async function claimMuralAccountCredit(
  env: Env,
  input: {
    transfer: PaymentTransferRow;
    counterpartyId: string;
    deliveryId: string;
    tokenAmount: number;
  }
): Promise<MuralAccountCreditClaim> {
  const row = await getDb(env)
    .prepare(
      `WITH counterparty_lock AS (
         SELECT status,
                provider_data->'mural'->'organization'->>'kycStatus'
                    AS mural_kyc_status
           FROM counterparties
          WHERE id = ?
          FOR UPDATE
       )
       UPDATE payment_transfers
          SET status = 'completed',
              updated_at = ?,
              amount = ?,
              provider_data = provider_data || ?::jsonb
        WHERE id = ?
          AND organization_id = ?
          AND project_id IS NOT DISTINCT FROM ?
          AND status = 'awaiting_payment'
          AND NOT EXISTS (
            SELECT 1
              FROM counterparty_lock
             WHERE status = 'active'
               AND mural_kyc_status IN ('rejected', 'errored')
          )
        RETURNING id`
    )
    .bind(
      input.counterpartyId,
      new Date().toISOString(),
      String(input.tokenAmount),
      JSON.stringify({
        mural: {
          ...readMuralData(input.transfer),
          accountCreditedDeliveryId: input.deliveryId,
        },
      }),
      input.transfer.id,
      input.transfer.organization_id,
      input.transfer.project_id
    )
    .first<{ id: string }>();
  if (row) {
    return "completed";
  }
  // No row matched: the statement's WHERE clause guards exactly two things
  // beyond identity — `status = 'awaiting_payment'` and the compliance gate —
  // so classify by re-reading the TRANSFER, not the compliance state. The
  // transfer's status is what the failed statement actually raced on: still
  // `awaiting_payment` means the gate blocked the claim (a compliance state
  // re-read here could already have cleared and would misreport the block as
  // "claimed elsewhere", discharging the only record of the credit); anything
  // else means another apply moved it out of `awaiting_payment`.
  const transferNow = await getDb(env)
    .prepare(
      `SELECT status
         FROM payment_transfers
        WHERE id = ?
          AND organization_id = ?
          AND project_id IS NOT DISTINCT FROM ?`
    )
    .bind(input.transfer.id, input.transfer.organization_id, input.transfer.project_id)
    .first<{ status: string }>();
  return transferNow?.status === "awaiting_payment" ? "blocked" : "already_claimed";
}

async function handleAccountCredited(
  env: Env,
  event: {
    organizationId: string;
    accountId: string;
    tokenAmount: number;
    deliveryId: string;
  }
): Promise<void> {
  getLogger().info(
    `[mural webhook] account_credited account=${event.accountId} amount=${event.tokenAmount} org=${event.organizationId}`
  );
  const counterparty = await createSystemCounterpartiesRepository(
    env
  ).findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    getLogger().warn(`[mural webhook] no counterparty for org ${event.organizationId}`);
    return;
  }
  // Re-check the effective compliance state before moving money: a signed
  // rejection or review error cached on the counterparty bars settlement even
  // while Mural still credits the account. Counterparties without cached Mural
  // organization state keep their existing settlement flow.
  const complianceStatus = readCachedMuralOrganizationKycStatus(counterparty);
  if (complianceStatus === "rejected" || complianceStatus === "errored") {
    getLogger().warn(
      `[mural webhook] refusing account credit for counterparty ${counterparty.id}: compliance status "${complianceStatus}"`
    );
    // Throw a DEFERRABLE error rather than return: a refusal that returned
    // would discharge the inbox row and destroy the only signed record of the
    // credit, leaving the transfer `awaiting_payment` with nothing to replay
    // once the compliance error clears and the organization is approved again.
    // Deferring keeps the event pending with its attempt budget restored, so
    // the replay job retries it every pass — parking it as a failed attempt
    // would strand the credit until an unrelated deploy re-armed the row.
    throw new DeferrableRampWebhookError(
      `[mural webhook] account credit deferred for counterparty ${counterparty.id}: compliance status "${complianceStatus}"`
    );
  }
  const payments = createSystemPaymentsRepository(env);
  const replay = await getDb(env)
    .prepare(
      `SELECT id
       FROM payment_transfers
       WHERE provider = 'mural'
         AND provider_data->'mural'->>'accountCreditedDeliveryId' = ?
       LIMIT 1`
    )
    .bind(event.deliveryId)
    .first<{ id: string }>();
  if (replay) {
    return;
  }
  const transfer = await findMuralOnrampTransfer(env, payments, counterparty, event.accountId, [
    "awaiting_payment",
  ]);
  if (!transfer) {
    getLogger().warn(
      `[mural webhook] no awaiting on-ramp transfer for counterparty ${counterparty.id}`
    );
    return;
  }

  const claim = await claimMuralAccountCredit(env, {
    transfer,
    counterpartyId: counterparty.id,
    deliveryId: event.deliveryId,
    tokenAmount: event.tokenAmount,
  });
  if (claim === "already_claimed") {
    return;
  }
  if (claim === "blocked") {
    getLogger().warn(
      `[mural webhook] refusing account credit for counterparty ${counterparty.id}: compliance blocked at claim time`
    );
    // Same deferral discipline as the pre-check refusal above: the claim's
    // compliance gate blocked the settlement, so the event must stay pending
    // (never parked) until the cached state allows it to apply.
    throw new DeferrableRampWebhookError(
      `[mural webhook] account credit deferred for counterparty ${counterparty.id}: compliance blocked at claim time`
    );
  }
  getLogger().info(
    `[mural webhook] transfer ${transfer.id} completed (payin ${event.tokenAmount})`
  );
}

const MURAL_TERMINAL_KYC_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected"]);

/**
 * Whether an incoming KYC status must not overwrite the cached state.
 *
 * A recorded `rejected` is a delivered compliance decision and stays sticky: a
 * late or replayed event — a stale `approved`, a review `error`, or a
 * pre-decision status — must never reverse it, because an approval applied
 * after a rejection re-opens quote eligibility and account-credit settlement.
 * Only a fresh signed `rejected` re-applies, idempotently.
 *
 * A review `error` is a provider processing failure, not a decision: it is
 * never stale, so it clears a cached approval (settlement treats `errored` as
 * blocking). A replayed error clearing a newer approval is fail-safe —
 * settlement stays blocked until the next signed approval arrives — while an
 * ignored error would leave money moving on a review the provider no longer
 * has.
 *
 * `errored` is itself a blocking cached state: a delayed or replayed
 * pre-decision status (`pending`) must not clear it, or a credit refused
 * during the review error would settle on replay without any signed approval.
 * Only a terminal decision (`approved`, or a fresh `rejected`) supersedes it.
 */
function isStaleMuralKycStatus(counterparty: CounterpartyRow, incoming: MuralKycStatus): boolean {
  const cached = readCachedMuralOrganizationKycStatus(counterparty);
  if (cached === "rejected") {
    return incoming !== "rejected";
  }
  if (incoming === "errored" || MURAL_TERMINAL_KYC_STATUSES.has(incoming)) {
    return false;
  }
  return MURAL_TERMINAL_KYC_STATUSES.has(cached ?? "") || cached === "errored";
}

function readCachedMuralOrganizationKycStatus(counterparty: CounterpartyRow): string | undefined {
  const mural = counterparty.provider_data.mural;
  const organization =
    mural && typeof mural === "object" && !Array.isArray(mural)
      ? (mural as Record<string, unknown>).organization
      : undefined;
  const current =
    organization && typeof organization === "object" && !Array.isArray(organization)
      ? (organization as Record<string, unknown>).kycStatus
      : undefined;
  return typeof current === "string" ? current : undefined;
}

async function handleOrganizationLifecycleEvent(
  env: Env,
  event: Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }>
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(env);
  const counterparty = await repo.findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    getLogger().warn(`[mural webhook] no counterparty for organization ${event.organizationId}`);
    return;
  }
  if (event.kind === "kyc_status" && isStaleMuralKycStatus(counterparty, event.kycStatus)) {
    // A replayed pre-decision event must not undo a delivered compliance
    // decision: the inbox can re-apply an old `pending` after `approved` or
    // `rejected` already landed.
    getLogger().info(
      `[mural webhook] ignoring stale kyc status "${event.kycStatus}" for ${counterparty.id}${
        event.source === undefined ? "" : ` (${event.source.kind} ${event.source.id})`
      }`
    );
    return;
  }
  if (event.kind === "kyc_status" && event.source !== undefined) {
    getLogger().info(
      `[mural webhook] ${event.source.kind} ${event.source.id} set kyc "${event.kycStatus}" for ${counterparty.id}`
    );
  }
  const organization: Record<string, unknown> =
    event.kind === "kyc_status" ? { kycStatus: event.kycStatus } : { tosStatus: "ACCEPTED" };
  await repo.patchMuralOrganizationById({
    organizationId: event.organizationId,
    organization,
  });

  // Mirror the KYC status onto the SDP-owned kyc_wallets. No-op when the counterparty
  // has no registered kyc_wallets.
  if (event.kind === "kyc_status") {
    await createKycWalletsRepository(env).setKycStatusByCounterparty({
      counterpartyId: counterparty.id,
      organizationId: counterparty.organization_id,
      projectId: counterparty.project_id,
      status: mapMuralKycStatusToSdp(event.kycStatus),
      provider: "mural",
    });
  }
}

export class MuralWebhookProcessor implements WebhookProcessor<unknown, MuralProcessorEvent> {
  readonly provider = "mural";

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
    const publicKey = readMuralWebhookPublicKey(env, environment);
    const signature = headers.get("x-mural-webhook-signature")?.trim();
    if (!signature) {
      throw unauthorized("Mural webhook is missing x-mural-webhook-signature");
    }
    const timestamp = headers.get("x-mural-webhook-timestamp")?.trim();
    if (!timestamp) {
      throw unauthorized("Mural webhook is missing x-mural-webhook-timestamp");
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: `${timestamp}.${rawBody}`,
      signature,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey, encoding: "base64" },
      timestampSeconds: Date.parse(timestamp) / 1000,
    });

    try {
      const payload = JSON.parse(rawBody) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        return {
          ...(payload as Record<string, unknown>),
          [MURAL_DELIVERY_ID_FIELD]: await muralDeliveryId(timestamp, rawBody),
        };
      }
      return payload;
    } catch {
      throw badRequest("Mural webhook body must be valid JSON", { provider: this.provider });
    }
  }

  parse(payload: unknown): MuralProcessorEvent {
    const event = RAMP_PROVIDER_CLIENTS.mural.parseMuralWebhookEvent(payload);
    if (event.kind !== "account_credited") {
      return event;
    }
    const deliveryId =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)[MURAL_DELIVERY_ID_FIELD]
        : undefined;
    if (typeof deliveryId !== "string" || deliveryId.length === 0) {
      throw badRequest("Mural webhook is missing its verified delivery id", { provider: "mural" });
    }
    return { ...event, deliveryId };
  }

  async process(env: Env, _environment: SdpEnvironment, event: MuralProcessorEvent): Promise<void> {
    switch (event.kind) {
      case "ignore":
        getLogger().info(`[mural webhook] ignored event: ${event.reason}`);
        return;
      case "kyc_status":
      case "tos_accepted":
        return handleOrganizationLifecycleEvent(env, event);
      case "account_credited":
        return handleAccountCredited(env, event);
      case "payout_settled":
        await applyRampSettlementEvent(env, {
          provider: "mural",
          kind: "settled",
          reference: event.payoutRequestId,
        });
        return;
      case "payout_failed":
        await applyRampSettlementEvent(env, {
          provider: "mural",
          kind: "failed",
          reference: event.payoutRequestId,
        });
        return;
    }
  }
}
