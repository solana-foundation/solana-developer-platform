import type { SdpEnvironment } from "@sdp/types";
import { AppError, badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { readRecord, readString } from "@/lib/json";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@/lib/ramps/types";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import type { AppContext, WebhookProcessor } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

const STRIPE_SESSION_STATUS = {
  requires_payment: "awaiting_payment",
  fulfillment_processing: "settling",
  fulfillment_complete: "settled",
  rejected: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

interface StripeSignatureHeader {
  timestamp: string;
  signatures: string[];
}

function readStripeWebhookSecret(env: Record<string, string | undefined>): string {
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw providerNotConfigured("Stripe webhook secret is not configured (STRIPE_WEBHOOK_SECRET).");
  }
  return secret;
}

function parseStripeSignatureHeader(header: string): StripeSignatureHeader | undefined {
  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const prefix = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (prefix === "t") {
      timestamp = value;
    }
    if (prefix === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return undefined;
  }
  return { timestamp, signatures };
}

async function verifyStripeSignatures(input: {
  provider: string;
  secret: string;
  timestamp: string;
  rawBody: string;
  signatures: readonly string[];
}): Promise<void> {
  let firstUnauthorized: AppError | undefined;
  for (const signature of input.signatures) {
    try {
      await verifyWebhookSignature({
        provider: input.provider,
        signedPayload: `${input.timestamp}.${input.rawBody}`,
        signature,
        algorithm: { type: "hmac-sha256", secret: input.secret, encoding: "hex" },
        timestampSeconds: Number(input.timestamp),
      });
      return;
    } catch (error) {
      if (error instanceof AppError && error.code === "UNAUTHORIZED") {
        if (!firstUnauthorized) {
          firstUnauthorized = error;
        }
        continue;
      }
      throw error;
    }
  }
  if (firstUnauthorized) {
    throw firstUnauthorized;
  }
  throw unauthorized("Invalid Stripe webhook signature");
}

export class StripeWebhookProcessor implements WebhookProcessor<unknown, RampSettlementEvent> {
  readonly provider = "stripe";

  async verify({ env, headers, rawBody }: RampWebhookValidationContext): Promise<unknown> {
    const secret = readStripeWebhookSecret(env);
    const signatureHeader = headers.get("stripe-signature")?.trim();
    if (!signatureHeader) {
      throw unauthorized("Stripe webhook is missing the Stripe-Signature header");
    }

    const parsed = parseStripeSignatureHeader(signatureHeader);
    if (!parsed) {
      throw unauthorized("Stripe webhook signature header is malformed");
    }

    await verifyStripeSignatures({
      provider: this.provider,
      secret,
      timestamp: parsed.timestamp,
      rawBody,
      signatures: parsed.signatures,
    });

    try {
      return JSON.parse(rawBody);
    } catch {
      throw badRequest("Stripe webhook body must be valid JSON", { provider: this.provider });
    }
  }

  parse(payload: unknown): RampSettlementEvent {
    const root = readRecord(payload);
    if (!root) {
      throw badRequest("Stripe webhook body must be an object", { provider: this.provider });
    }

    const type = readString(root.type);
    if (type !== "crypto.onramp_session.updated") {
      return { provider: this.provider, kind: "ignore", reason: `unsupported_event:${type}` };
    }

    const data = readRecord(root.data);
    const session = data ? readRecord(data.object) : undefined;
    if (!session) {
      throw badRequest(`Stripe "${type}" webhook is missing the session object`, {
        provider: this.provider,
      });
    }

    const reference = readString(session.id);
    if (!reference) {
      throw badRequest(`Stripe "${type}" webhook is missing the session id`, {
        provider: this.provider,
      });
    }

    const status = readString(session.status);
    if (status === undefined) {
      throw badRequest(`Stripe "${type}" webhook is missing the session status`, {
        provider: this.provider,
      });
    }
    const kind = STRIPE_SESSION_STATUS[status as keyof typeof STRIPE_SESSION_STATUS];
    if (!kind) {
      return { provider: this.provider, kind: "ignore", reason: `unsupported_status:${status}` };
    }
    if (kind === "failed") {
      return {
        provider: this.provider,
        kind,
        reference,
        error: "Stripe rejected the on-ramp session.",
      };
    }
    if (kind === "settled") {
      const transactionDetails = readRecord(session.transaction_details);
      const receivedAmount = transactionDetails
        ? readString(transactionDetails.destination_amount)
        : undefined;
      return {
        provider: this.provider,
        kind,
        reference,
        ...(receivedAmount ? { receivedAmount } : {}),
      };
    }
    return { provider: this.provider, kind, reference };
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      console.log(`[stripe webhook] ignored event: ${event.reason}`);
      return;
    }
    await applyRampSettlementEvent(c, event);
  }
}
