import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { MuralWebhookEvent } from "@sdp/payments/ramps/providers/mural/client";
import type { MuralKycStatus } from "@sdp/payments/ramps/providers/mural/provider-data";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { KycStatus, SdpEnvironment } from "@sdp/types";
import { asTransactionalClient, getDb } from "@/db";
import { asPostgresJsonObject } from "@/db/postgres-utils";
import {
  createPostgresCounterpartiesRepository,
  createPostgresKycWalletsRepository,
  createSystemCounterpartiesRepository,
  createSystemPaymentsRepository,
  type PaymentsRepository,
  type PaymentTransferRow,
  type PaymentTransferStatus,
} from "@/db/repositories";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { Env } from "@/types/env";
import type { WebhookProcessor } from "./processor";

const MURAL_DELIVERY_ID_FIELD = "__sdpDeliveryId";

/**
 * How many times one lifecycle delivery re-resolves the active owner of its
 * Mural organization after the lock shows that the row it locked no longer
 * owns it. Bounded so a pathological reassignment loop parks the inbox row
 * for replay instead of looping forever.
 */
const MURAL_LIFECYCLE_OWNER_RECHECKS = 3;

type MuralProcessorEvent =
  | Exclude<MuralWebhookEvent, { kind: "account_credited" | "kyc_status" | "tos_accepted" }>
  | (Extract<MuralWebhookEvent, { kind: "account_credited" }> & { deliveryId: string })
  | (Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }> & { deliveryId: string });

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

  const claimed = await payments.updateTransferStatusGuarded({
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
    fromStatuses: ["awaiting_payment"],
    toStatus: "completed",
    updatedAt: new Date().toISOString(),
    amount: String(event.tokenAmount),
    providerData: {
      mural: {
        ...readMuralData(transfer),
        accountCreditedDeliveryId: event.deliveryId,
      },
    },
  });
  if (!claimed) {
    return;
  }
  getLogger().info(
    `[mural webhook] transfer ${transfer.id} completed (payin ${event.tokenAmount})`
  );
}

const MURAL_TERMINAL_KYC_STATUSES: ReadonlySet<string> = new Set(["approved", "rejected"]);

/** The denormalized Mural organization record a lifecycle event mutates, or undefined. */
function readMuralOrganization(mural: unknown): Record<string, unknown> | undefined {
  if (!mural || typeof mural !== "object" || Array.isArray(mural)) {
    return undefined;
  }
  const organization = (mural as Record<string, unknown>).organization;
  return organization && typeof organization === "object" && !Array.isArray(organization)
    ? (organization as Record<string, unknown>)
    : undefined;
}

function readMuralOrganizationRecord(
  counterparty: CounterpartyRow
): Record<string, unknown> | undefined {
  return readMuralOrganization(counterparty.provider_data.mural);
}

/** The Mural organization id a counterparty's provider_data is keyed on, or undefined. */
function readMuralOrganizationId(
  organization: Record<string, unknown> | undefined
): string | undefined {
  const id = organization?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** A non-decision status arriving after a recorded decision is a replayed stale event. */
function isStaleMuralKycStatus(
  currentOrganization: Record<string, unknown> | undefined,
  incoming: MuralKycStatus
): boolean {
  if (MURAL_TERMINAL_KYC_STATUSES.has(incoming)) {
    return false;
  }
  const current = currentOrganization?.kycStatus;
  return typeof current === "string" && MURAL_TERMINAL_KYC_STATUSES.has(current);
}

/**
 * One lookup-lock-apply pass against the current active owner of the event's
 * Mural organization. `"owner-changed"` means the row locked was removed,
 * archived, or no longer owns the organization: nothing was mutated or
 * admitted, and the caller re-resolves the owner and tries again.
 */
async function applyMuralLifecycleToCurrentOwner(
  env: Env,
  event: Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }> & {
    deliveryId: string;
  }
): Promise<"done" | "owner-changed"> {
  const counterparty = await createSystemCounterpartiesRepository(
    env
  ).findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    // No active counterparty owns the organization: nothing to mutate, and a
    // retry would resolve the same way, so the delivery is acknowledged.
    getLogger().warn(`[mural webhook] no counterparty for organization ${event.organizationId}`);
    return "done";
  }
  if (
    event.kind === "kyc_status" &&
    isStaleMuralKycStatus(readMuralOrganizationRecord(counterparty), event.kycStatus)
  ) {
    // A replayed pre-decision event must not undo a delivered compliance
    // decision: the inbox can re-apply an old `pending` after `approved` or
    // `rejected` already landed.
    getLogger().info(
      `[mural webhook] ignoring stale kyc status "${event.kycStatus}" for ${counterparty.id}`
    );
    return "done";
  }

  // A signed lifecycle webhook outlives its durable inbox row — applyStoredRampWebhookEvent
  // deletes that row once processing succeeds — so the append-only audit ledger is the only
  // evidence a compliance decision happened. The counterparty row is locked first and the
  // durable intent is admitted only under that lock: if the ledger refuses it, the mutation
  // never happens and the inbox row retries, and the verified provider delivery id binds
  // the admission to the exact signed event that caused it.
  const statusScope = event.kind === "kyc_status" ? "kyc" : "tos";
  const newStatus = event.kind === "kyc_status" ? event.kycStatus : "ACCEPTED";
  const audit = new AuditService(getDb(env), createKVStoreSet(env).cache);
  let intent: AuditIntent | undefined;
  let ownerChanged = false;

  try {
    await getDb(env).transaction(async (tx) => {
      const client = asTransactionalClient(tx);
      // Lock the counterparty row before reading the prior status or admitting
      // the intent. Concurrent lifecycle deliveries for the same Mural
      // organization serialize here, so every admission records the prior
      // status that was actually current when its write landed — the ledger
      // never retells a transition from a status another writer replaced.
      const locked = await client
        .prepare(
          "SELECT status, mural_organization_id, provider_data FROM counterparties WHERE id = ? FOR UPDATE"
        )
        .bind(counterparty.id)
        .first<{
          status: string;
          mural_organization_id: string | null;
          provider_data: unknown;
        }>();
      if (!locked) {
        // The counterparty was removed between the lookup and the lock:
        // re-resolve the organization's current owner instead of admitting
        // anything against a row that no longer exists.
        ownerChanged = true;
        return;
      }
      const currentOrganization = readMuralOrganization(
        asPostgresJsonObject(locked.provider_data).mural
      );
      // Re-validated under the lock: the patch below and the audit outcome
      // both target the Mural organization this row was looked up by, not an
      // immutable row id, so the locked row must still be active and still
      // own that organization. An archive-and-reassign inside the lookup
      // window must not mutate a successor counterparty while the audit
      // record names the archived one — or nobody. The effective-reference
      // unique index (column first, JSON fallback) guarantees an active row
      // matching this organization can only be this row.
      if (
        locked.status !== "active" ||
        (locked.mural_organization_id ?? readMuralOrganizationId(currentOrganization)) !==
          event.organizationId
      ) {
        ownerChanged = true;
        getLogger().info(
          `[mural webhook] counterparty ${counterparty.id} is no longer the active owner of Mural organization ${event.organizationId}; re-resolving its owner`
        );
        return;
      }
      if (
        event.kind === "kyc_status" &&
        isStaleMuralKycStatus(currentOrganization, event.kycStatus)
      ) {
        // Re-checked under the lock: a pre-decision event that raced the
        // decision delivery must not undo it. Acknowledged: the event is
        // stale for the current owner, and re-resolving cannot freshen it.
        getLogger().info(
          `[mural webhook] ignoring stale kyc status "${event.kycStatus}" for ${counterparty.id}`
        );
        return;
      }
      const oldStatus =
        event.kind === "kyc_status"
          ? currentOrganization?.kycStatus
          : currentOrganization?.tosStatus;
      intent = await audit.beginCriticalSystem({
        organizationId: counterparty.organization_id,
        requestId: event.deliveryId,
        action: "update",
        resourceType: "counterparty",
        resourceId: counterparty.id,
        metadata: {
          provider: "mural",
          trigger: "mural_webhook",
          eventKind: event.kind,
          providerEventId: event.deliveryId,
          muralOrganizationId: event.organizationId,
          projectId: counterparty.project_id,
          counterpartyId: counterparty.id,
          statusScope,
          oldStatus: oldStatus ?? null,
          newStatus,
          walletScope: event.kind === "kyc_status" ? "counterparty_kyc_wallets" : null,
        },
      });

      // The counterparty patch and the normalized KYC-wallet mirror derive from one
      // provider event, so they land or roll back together.
      const organization: Record<string, unknown> =
        event.kind === "kyc_status" ? { kycStatus: event.kycStatus } : { tosStatus: "ACCEPTED" };
      await createPostgresCounterpartiesRepository(client).patchMuralOrganizationById({
        organizationId: event.organizationId,
        organization,
      });

      // Mirror the KYC status onto the SDP-owned kyc_wallets. No-op when the counterparty
      // has no registered kyc_wallets.
      if (event.kind === "kyc_status") {
        await createPostgresKycWalletsRepository(client).setKycStatusByCounterparty({
          counterpartyId: counterparty.id,
          organizationId: counterparty.organization_id,
          projectId: counterparty.project_id,
          status: mapMuralKycStatusToSdp(event.kycStatus),
          provider: "mural",
        });
      }
    });
  } catch (error) {
    // The transaction rolled back, so the admitted operation produced no
    // success-shaped outcome. Record a failure outcome against the durable
    // intent — an abort is not a success — so a successful inbox retry does
    // not strand an earlier intent unresolved, which would fail integrity
    // verification forever despite the delivery eventually succeeding. If
    // this outcome write also fails, the intent stays unresolved for
    // operator reconciliation and the inbox row keeps the payload for retry.
    getLogger().error(
      {
        err: error,
        audit_intent_id: intent?.id,
        counterparty_id: counterparty.id,
        event_kind: event.kind,
        provider_event_id: event.deliveryId,
      },
      "[mural webhook] lifecycle mutation failed after audit admission"
    );
    if (intent) {
      const resolved = await audit.completeCriticalSystem(intent, {
        status: "failure",
        metadata: { result: "aborted" },
      });
      if (!resolved) {
        getLogger().error(
          { audit_intent_id: intent.id, provider_event_id: event.deliveryId },
          "[mural webhook] aborted lifecycle outcome was not persisted; intent left unresolved for reconciliation"
        );
      }
    }
    throw error;
  }
  if (ownerChanged) {
    return "owner-changed";
  }
  if (intent) {
    await audit.completeCriticalSystem(intent, {
      metadata: {
        result: "applied",
        ...(event.kind === "kyc_status"
          ? { normalizedKycStatus: mapMuralKycStatusToSdp(event.kycStatus) }
          : {}),
      },
    });
  }
  return "done";
}

async function handleOrganizationLifecycleEvent(
  env: Env,
  event: Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }> & {
    deliveryId: string;
  }
): Promise<void> {
  for (let attempt = 0; attempt < MURAL_LIFECYCLE_OWNER_RECHECKS; attempt += 1) {
    if ((await applyMuralLifecycleToCurrentOwner(env, event)) === "done") {
      return;
    }
    getLogger().info(
      `[mural webhook] Mural organization ${event.organizationId} changed owner while applying ${event.kind} ${event.deliveryId}; re-applying to its current owner`
    );
  }
  // The owner kept changing through every bounded re-resolve. Fail the apply
  // (non-terminal): the inbox keeps the verified payload and retries, so the
  // signed compliance decision lands on whichever counterparty owns the
  // organization once the reassignment settles — or parks as failed and
  // pages — instead of being acknowledged unapplied.
  throw new Error(
    `[mural webhook] Mural organization ${event.organizationId} changed owners on every re-resolve while applying ${event.kind} ${event.deliveryId}; leaving the delivery pending for retry`
  );
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
    if (
      event.kind !== "account_credited" &&
      event.kind !== "kyc_status" &&
      event.kind !== "tos_accepted"
    ) {
      return event;
    }
    // Settlement and lifecycle events alike bind to the signature-verified
    // delivery digest: account_credited for replay protection, lifecycle
    // events as the audit-ledger admission's provider-event binding.
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
