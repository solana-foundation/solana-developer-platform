import {
  type HercleVerificationStatus,
  mapHercleVerificationStatus,
} from "@sdp/payments/ramps/providers/hercle/provider-data";
import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import { getDb } from "@/db";
import { createSystemCounterpartiesRepository } from "@/db/repositories";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import { badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import {
  patchVerificationStatus,
  readHercleCounterpartyLink,
} from "@/routes/payments/handlers/ramps/hercle";
import { getLogger } from "@/runtime/logger";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { AppContext, WebhookProcessor } from "./processor";

/**
 * Hercle webhooks: ECDSA P-256 (SHA-256) over `${X-Timestamp}.${rawBody}` with a base64
 * `X-Signature`; SDP holds only Hercle's public key. Envelope `{event, timestamp, data}`;
 * every event echoes the order reference Hercle minted at quote time (the providerReference
 * SDP persisted), so settlement lookups need no per-provider correlation state.
 */
const HERCLE_SETTLEMENT_STATUSES = [
  "awaiting_payment",
  "settling",
  "settled",
  "failed",
  "expired",
] as const;
type HercleSettlementStatus = (typeof HERCLE_SETTLEMENT_STATUSES)[number];

export type HercleWebhookEvent =
  | {
      kind: "settlement";
      reference: string;
      status: HercleSettlementStatus;
      receivedAmount?: string;
      error?: string;
    }
  | {
      kind: "verification";
      accountId: string;
      status: HercleVerificationStatus;
      verificationUrl?: string;
    }
  | { kind: "ignore"; reason: string };

function readHercleWebhookPublicKey(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  const publicKey =
    environment === "sandbox"
      ? env.HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY?.trim()
      : env.HERCLE_WEBHOOK_PUBLIC_KEY?.trim();
  if (!publicKey) {
    throw providerNotConfigured(
      environment === "sandbox"
        ? "Hercle sandbox webhook public key is not configured (HERCLE_SANDBOX_WEBHOOK_PUBLIC_KEY)."
        : "Hercle webhook public key is not configured (HERCLE_WEBHOOK_PUBLIC_KEY)."
    );
  }
  return publicKey;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseHercleWebhookEvent(payload: unknown): HercleWebhookEvent {
  const root = readRecord(payload);
  const event = root === undefined ? undefined : readString(root.event);
  if (event === undefined) {
    // A violated envelope guarantee must fail loudly — everything else is a skip.
    throw badRequest("Hercle webhook is missing the event field", { provider: "hercle" });
  }
  const data = readRecord(root?.data);

  switch (event) {
    case "ramp.settlement.status_changed": {
      const reference = data === undefined ? undefined : readString(data.reference);
      const status = data === undefined ? undefined : readString(data.status);
      if (!reference || !status) {
        throw badRequest(`Hercle "${event}" webhook is missing reference or status`, {
          provider: "hercle",
        });
      }
      if (!(HERCLE_SETTLEMENT_STATUSES as readonly string[]).includes(status)) {
        return { kind: "ignore", reason: `unknown_settlement_status:${status}` };
      }
      return {
        kind: "settlement",
        reference,
        status: status as HercleSettlementStatus,
        receivedAmount: data === undefined ? undefined : readString(data.receivedAmount),
        error: data === undefined ? undefined : readString(data.error),
      };
    }
    case "customer.verification.status_changed": {
      const accountId = data === undefined ? undefined : readString(data.accountId);
      const status = data === undefined ? undefined : readString(data.status);
      if (!accountId || !status) {
        throw badRequest(`Hercle "${event}" webhook is missing accountId or status`, {
          provider: "hercle",
        });
      }
      return {
        kind: "verification",
        accountId,
        status: mapHercleVerificationStatus(status),
        verificationUrl: data === undefined ? undefined : readString(data.verificationUrl),
      };
    }
    default:
      return { kind: "ignore", reason: `unhandled_event:${event}` };
  }
}

/**
 * Moves the customer link's verification state; the hosted link on the event is not stored, since
 * Hercle mints it per read.
 */
async function handleVerificationEvent(
  c: AppContext,
  event: Extract<HercleWebhookEvent, { kind: "verification" }>
): Promise<void> {
  const counterparty = await createSystemCounterpartiesRepository(
    c.env
  ).findActiveCounterpartyByProviderCustomerReference({
    provider: "hercle",
    providerCustomerReference: event.accountId,
  });
  if (!counterparty) {
    getLogger().warn(`[hercle webhook] no counterparty for account ${event.accountId}`);
    return;
  }
  const link = await readHercleCounterpartyLink(c, counterparty);
  if (!link) {
    getLogger().warn(`[hercle webhook] no customer link for account ${event.accountId}`);
    return;
  }
  await patchVerificationStatus(
    createPostgresCounterpartyProviderAccountsRepository(getDb(c.env)),
    {
      organizationId: counterparty.organization_id,
      projectId: counterparty.project_id,
      counterpartyId: counterparty.id,
      provider: "hercle",
    },
    link.linkRowId,
    event.status
  );
}

export class HercleWebhookProcessor implements WebhookProcessor<unknown, HercleWebhookEvent> {
  readonly provider = "hercle";

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
    const publicKey = readHercleWebhookPublicKey(env, environment);
    const signature = headers.get("x-signature")?.trim();
    if (!signature) {
      throw unauthorized("Hercle webhook is missing X-Signature");
    }
    const timestamp = headers.get("x-timestamp")?.trim();
    if (!timestamp) {
      throw unauthorized("Hercle webhook is missing X-Timestamp");
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: `${timestamp}.${rawBody}`,
      signature,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey, encoding: "base64" },
      // X-Timestamp is unix seconds; a non-numeric header yields NaN and is refused.
      timestampSeconds: Number(timestamp),
    });

    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      throw badRequest("Hercle webhook body must be valid JSON", { provider: this.provider });
    }
  }

  parse(payload: unknown): HercleWebhookEvent {
    return parseHercleWebhookEvent(payload);
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: HercleWebhookEvent) {
    switch (event.kind) {
      case "ignore":
        getLogger().info(`[hercle webhook] ignored event: ${event.reason}`);
        return;
      case "verification":
        return handleVerificationEvent(c, event);
      case "settlement":
        switch (event.status) {
          case "awaiting_payment":
            return applyRampSettlementEvent(c.env, {
              provider: "hercle",
              kind: "awaiting_payment",
              reference: event.reference,
            });
          case "settling":
            return applyRampSettlementEvent(c.env, {
              provider: "hercle",
              kind: "settling",
              reference: event.reference,
            });
          case "settled":
            return applyRampSettlementEvent(c.env, {
              provider: "hercle",
              kind: "settled",
              reference: event.reference,
              receivedAmount: event.receivedAmount,
            });
          case "failed":
          case "expired":
            return applyRampSettlementEvent(c.env, {
              provider: "hercle",
              kind: event.status,
              reference: event.reference,
              error: event.error,
            });
        }
    }
  }
}
