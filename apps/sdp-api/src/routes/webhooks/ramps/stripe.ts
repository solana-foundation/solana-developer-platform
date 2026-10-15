import { readRecord, readString } from "@sdp/payments/json";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import { z } from "zod";
import { AppError, badRequest, providerNotConfigured, unauthorized } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { Env } from "@/types/env";
import type { WebhookProcessor } from "./processor";

const STRIPE_SESSION_STATUS = {
  requires_payment: "awaiting_payment",
  fulfillment_processing: "settling",
  fulfillment_complete: "settled",
  rejected: "failed",
} as const satisfies Record<string, RampSettlementEvent["kind"]>;

type DeliveredAssetRail = NonNullable<
  Extract<RampSettlementEvent, { kind: "settled" }>["deliveredAssetRail"]
>;

/** The rail each Stripe destination currency settles on, on Solana. */
const STRIPE_SOLANA_RAILS = {
  usdc: "usdc.solana",
  sol: "sol.solana",
} as const satisfies Record<string, DeliveredAssetRail>;

function isStripeSolanaCurrency(currency: string): currency is keyof typeof STRIPE_SOLANA_RAILS {
  return Object.hasOwn(STRIPE_SOLANA_RAILS, currency);
}

/** The rail a completed Stripe session delivered, or null for an asset SDP does not sell on Solana. */
function stripeDeliveredAssetRail(currency: string, network: string): DeliveredAssetRail | null {
  if (network !== "solana" || !isStripeSolanaCurrency(currency)) {
    return null;
  }
  return STRIPE_SOLANA_RAILS[currency];
}

/** The one field every Stripe event carries that says which mode it ran in. */
const stripeEventModeSchema = z.object({ livemode: z.boolean() });

interface StripeSignatureHeader {
  timestamp: string;
  signatures: string[];
}

/**
 * The secret that signs `environment`'s Stripe events. SDP holds the sandbox
 * secret only: production projects bring their own Stripe account (HOO-1943).
 */
function readStripeWebhookSecret(
  env: Record<string, string | undefined>,
  environment: SdpEnvironment
): string {
  if (environment === "production") {
    throw providerNotConfigured("Stripe webhooks are not configured for production.");
  }
  const secret = env.STRIPE_SANDBOX_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw providerNotConfigured(
      "Stripe sandbox webhook secret is not configured (STRIPE_SANDBOX_WEBHOOK_SECRET)."
    );
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

  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<unknown> {
    const secret = readStripeWebhookSecret(env, environment);
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

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw badRequest("Stripe webhook body must be valid JSON", { provider: this.provider });
    }
    const mode = stripeEventModeSchema.safeParse(payload);
    if (!mode.success) {
      throw badRequest("Stripe webhook is missing livemode", { provider: this.provider });
    }
    if (mode.data.livemode !== (environment === "production")) {
      throw badRequest(
        `Stripe ${mode.data.livemode ? "live" : "test"} event sent to the ${environment} webhook`,
        { provider: this.provider }
      );
    }
    return payload;
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
      const currency = transactionDetails
        ? readString(transactionDetails.destination_currency)
        : undefined;
      const network = transactionDetails
        ? readString(transactionDetails.destination_network)
        : undefined;
      if (currency === undefined || network === undefined) {
        throw badRequest(
          `Stripe "${type}" webhook is missing the completed session's destination currency or network`,
          { provider: this.provider }
        );
      }
      const receivedAmount = transactionDetails
        ? readString(transactionDetails.destination_amount)
        : undefined;
      return {
        provider: this.provider,
        kind,
        reference,
        deliveredAssetRail: stripeDeliveredAssetRail(currency, network),
        ...(receivedAmount ? { receivedAmount } : {}),
      };
    }
    return { provider: this.provider, kind, reference };
  }

  async process(env: Env, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      getLogger().info(`[stripe webhook] ignored event: ${event.reason}`);
      return;
    }
    await applyRampSettlementEvent(env, event);
  }
}
