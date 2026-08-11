import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { MuralWebhookEvent } from "@sdp/payments/ramps/providers/mural/client";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import {
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
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

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
  c: AppContext,
  payments: PaymentsRepository,
  counterparty: CounterpartyRow,
  accountId: string,
  statuses: PaymentTransferStatus[]
): Promise<PaymentTransferRow | undefined> {
  const matches = await getDb(c.env)
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
  c: AppContext,
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
    c.env
  ).findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    getLogger().warn(`[mural webhook] no counterparty for org ${event.organizationId}`);
    return;
  }
  const payments = createSystemPaymentsRepository(c.env);
  const replay = await getDb(c.env)
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
  const transfer = await findMuralOnrampTransfer(c, payments, counterparty, event.accountId, [
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

async function handleOrganizationLifecycleEvent(
  c: AppContext,
  event: Extract<MuralWebhookEvent, { kind: "kyc_status" | "tos_accepted" }>
): Promise<void> {
  const repo = createSystemCounterpartiesRepository(c.env);
  const counterparty = await repo.findCounterpartyByMuralOrganizationId(event.organizationId);
  if (!counterparty) {
    getLogger().warn(`[mural webhook] no counterparty for organization ${event.organizationId}`);
    return;
  }
  const organization: Record<string, unknown> =
    event.kind === "kyc_status" ? { kycStatus: event.kycStatus } : { tosStatus: "ACCEPTED" };
  await repo.patchMuralOrganizationById({
    organizationId: event.organizationId,
    organization,
  });
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

  async process(
    c: AppContext,
    _environment: SdpEnvironment,
    event: MuralProcessorEvent
  ): Promise<void> {
    switch (event.kind) {
      case "ignore":
        getLogger().info(`[mural webhook] ignored event: ${event.reason}`);
        return;
      case "kyc_status":
      case "tos_accepted":
        return handleOrganizationLifecycleEvent(c, event);
      case "account_credited":
        return handleAccountCredited(c, event);
      case "payout_settled":
        return applyRampSettlementEvent(c, {
          provider: "mural",
          kind: "settled",
          reference: event.payoutRequestId,
        });
      case "payout_failed":
        return applyRampSettlementEvent(c, {
          provider: "mural",
          kind: "failed",
          reference: event.payoutRequestId,
        });
    }
  }
}
