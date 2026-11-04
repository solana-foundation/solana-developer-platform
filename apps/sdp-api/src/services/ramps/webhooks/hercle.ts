import { hercleVerificationStatusEvent } from "@sdp/payments/ramps/providers/hercle/customer-status-mapping";
import {
  type HercleOrderStatus,
  hercleOrderSettlementEvent,
} from "@sdp/payments/ramps/providers/hercle/order-status-mapping";
import type { RampCustomerStatusEvent, RampSettlementEvent } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { RampWebhookProcessResult } from "@sdp/types/payments";
import { z } from "zod";
import { badRequest, unauthorized } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import { applyRampCustomerStatusEvent } from "@/services/ramps/customer-status-events";
import { managedRampWebhookSecret } from "@/services/ramps/runtime";
import type { Env } from "@/types/env";
import type { RampWebhookValidationContext, WebhookProcessor } from "./processor";

const HERCLE_SETTLEMENT_EVENT = "ramp.settlement.status_changed";
const HERCLE_VERIFICATION_EVENT = "customer.verification.status_changed";

/** What a Hercle webhook tells SDP: an order's settlement, or a business's verdict. */
export type HercleWebhookEvent = RampSettlementEvent | RampCustomerStatusEvent;

/** Every Hercle webhook: `{ event, timestamp, data }`, the event named before anything is read. */
const hercleEnvelopeSchema = z.object({ event: z.string().trim().min(1) });

/**
 * A verification event: the account Hercle opened for the business, and its verdict.
 * The envelope's `timestamp` (Unix seconds, inside the signed body) is the only ordering field Hercle sends.
 * `status` stays an open string so a verdict Hercle ships later maps to an ignore event.
 */
const hercleVerificationEnvelopeSchema = z.object({
  timestamp: z.number().int().positive(),
  data: z.object({
    accountId: z.string().trim().min(1),
    status: z.string().trim().min(1),
  }),
});

/**
 * The `data` of a settlement event.
 * The order id rides as `reference`, the id SDP bound the transfer to at quote time.
 * Its `receivedAmount` is the order's fiat, not the crypto delivered, so it is not read.
 */
const hercleSettlementDataSchema = z.object({
  reference: z.string().trim().min(1),
  status: z.string().trim().min(1),
  error: z.string().trim().min(1).nullish(),
  txHash: z.string().trim().min(1).nullish(),
  destinationWalletAddress: z.string().trim().min(1).nullish(),
});

const hercleSettlementEnvelopeSchema = z.object({ data: z.unknown().optional() });

/**
 * Hercle signs webhooks with ECDSA P-256 over `${X-Timestamp}.${rawBody}`: a base64 DER signature in X-Signature.
 * SDP verifies it with Hercle's public key.
 * Settlement events move a transfer, matched by its order id.
 * Verification events record the business's verdict on the customer link that names its account, so a revoked business stops showing ready and stops quoting.
 */
export const hercleWebhook = {
  provider: "hercle" as const,
  signature: {
    header: "x-signature",
    encoding: "base64",
    signedPayload: "timestamp-prefixed",
  } as const,

  /** Hercle's envelope carries no delivery id. */
  eventId(_rawBody: string): string | null {
    return null;
  },

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<string> {
    const publicKeyPem = managedRampWebhookSecret(env, this.provider, environment);
    const signature = headers.get("x-signature")?.trim();
    if (!signature) {
      throw unauthorized("Hercle webhook is missing the X-Signature header");
    }
    const timestamp = headers.get("x-timestamp")?.trim();
    if (!timestamp) {
      throw unauthorized("Hercle webhook is missing the X-Timestamp header");
    }
    await verifyWebhookSignature({
      provider: this.provider,
      signature,
      signedPayload: `${timestamp}.${rawBody}`,
      algorithm: { type: "ecdsa-p256-sha256", publicKeyPem, encoding: "base64" },
      // Unix seconds; a non-numeric header reads as NaN and is refused.
      timestampSeconds: Number(timestamp),
    });
    return rawBody;
  },

  parse(rawBody: string, _environment?: SdpEnvironment): HercleWebhookEvent {
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody);
    } catch {
      throw badRequest("Hercle webhook body must be valid JSON", { provider: this.provider });
    }
    const envelope = hercleEnvelopeSchema.safeParse(decoded);
    if (!envelope.success) {
      throw badRequest("Hercle webhook is missing its event name", { provider: this.provider });
    }
    const { event } = envelope.data;
    if (event === HERCLE_VERIFICATION_EVENT) {
      const verification = hercleVerificationEnvelopeSchema.safeParse(decoded);
      if (!verification.success) {
        throw badRequest(`Hercle "${event}" webhook carries a malformed verification`, {
          provider: this.provider,
          errors: verification.error.issues,
        });
      }
      return hercleVerificationStatusEvent({
        ...verification.data.data,
        timestamp: verification.data.timestamp,
      });
    }
    if (event !== HERCLE_SETTLEMENT_EVENT) {
      return { provider: this.provider, kind: "ignore", reason: `unsupported_event:${event}` };
    }

    // A documented event always carries its data, so one without it is a broken envelope.
    const settlement = hercleSettlementEnvelopeSchema.parse(decoded);
    if (settlement.data === undefined || settlement.data === null) {
      throw badRequest(`Hercle "${event}" webhook is missing its data envelope`, {
        provider: this.provider,
      });
    }
    const data = hercleSettlementDataSchema.safeParse(settlement.data);
    if (!data.success) {
      throw badRequest(`Hercle "${event}" webhook carries a malformed order`, {
        provider: this.provider,
        errors: data.error.issues,
      });
    }
    const order: HercleOrderStatus = {
      orderId: data.data.reference,
      status: data.data.status,
      error: data.data.error,
      txHash: data.data.txHash,
      destinationWalletAddress: data.data.destinationWalletAddress,
    };
    return hercleOrderSettlementEvent(order);
  },

  async process(
    env: Env,
    environment: SdpEnvironment,
    event: HercleWebhookEvent
  ): Promise<RampWebhookProcessResult> {
    if (event.kind === "ignore") {
      getLogger().info(`[hercle webhook] ignored event: ${event.reason}`);
      return { outcome: "ignored" };
    }
    if (event.kind === "customer_status") {
      return applyRampCustomerStatusEvent(env, environment, event);
    }
    return applyRampSettlementEvent(env, environment, event);
  },
} satisfies WebhookProcessor<HercleWebhookEvent>;
