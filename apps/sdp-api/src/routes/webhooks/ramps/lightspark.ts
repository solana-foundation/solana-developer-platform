import { requireEnv } from "@sdp/payments/ramps/shared";
import type { RampSettlementEvent, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import { formatDecimalAmount } from "@sdp/solana/amount";
import type { LightsparkGridAmount, LightsparkRampSettlement, SdpEnvironment } from "@sdp/types";
import { z } from "zod";
import { createSystemPaymentsRepository } from "@/db/repositories";
import { AppError, badRequest } from "@/lib/errors";
import { verifyWebhookSignature } from "@/lib/webhook-signature";
import { getLogger } from "@/runtime/logger";
import { logEvent } from "@/runtime/money-path-events";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import type { AppContext, WebhookProcessor } from "./processor";

const lightsparkEventTypeSchema = z.enum([
  "OUTGOING_PAYMENT.PENDING",
  "OUTGOING_PAYMENT.PROCESSING",
  "OUTGOING_PAYMENT.COMPLETED",
  "OUTGOING_PAYMENT.FAILED",
  "OUTGOING_PAYMENT.EXPIRED",
  "OUTGOING_PAYMENT.REFUND_FAILED",
]);

type LightsparkEventType = z.infer<typeof lightsparkEventTypeSchema>;

const LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES = {
  "OUTGOING_PAYMENT.PENDING": "awaiting_payment",
  "OUTGOING_PAYMENT.PROCESSING": "settling",
  "OUTGOING_PAYMENT.COMPLETED": "settled",
  "OUTGOING_PAYMENT.FAILED": "failed",
  "OUTGOING_PAYMENT.EXPIRED": "expired",
  "OUTGOING_PAYMENT.REFUND_FAILED": "failed",
} as const satisfies Record<LightsparkEventType, RampSettlementEvent["kind"]>;

const lightsparkAmountSchema = z
  .object({
    amount: z.number().int(),
    currency: z.object({
      code: z.string().trim().min(1),
      decimals: z.number().int(),
    }),
  })
  .transform(
    ({ amount, currency }) =>
      ({
        amount,
        currencyCode: currency.code.toUpperCase(),
        decimals: currency.decimals,
      }) satisfies LightsparkGridAmount
  );

/**
 * Grid transaction payload narrowed to the fields settlement consumes. Fields
 * Grid may add or vary are stripped rather than rejected so a payload change
 * never drops a settlement event.
 */
const lightsparkTransactionDataSchema = z.object({
  id: z.string().trim().min(1),
  status: z.string().trim().min(1),
  destination: z.object({
    onChainTransaction: z
      .object({
        transactionHash: z.string().trim().min(1),
        network: z.string().trim().min(1),
      })
      .optional(),
  }),
  customerId: z.string().trim().min(1),
  settledAt: z.string().trim().min(1).nullable().optional(),
  description: z.string(),
  sentAmount: lightsparkAmountSchema,
  exchangeRate: z.number(),
  quoteId: z.string().trim().min(1),
  receivedAmount: lightsparkAmountSchema,
  fees: z.number(),
  failureReason: z.string().nullable().optional(),
  reconciliationInstructions: z.object({ transactionHash: z.string().trim().min(1) }).optional(),
});

const lightsparkWebhookSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.PENDING"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("PENDING") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.PROCESSING"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("PROCESSING") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.COMPLETED"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("COMPLETED") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.FAILED"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("FAILED") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.EXPIRED"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("EXPIRED") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
  z.object({
    id: z.string().trim().min(1),
    type: z.literal("OUTGOING_PAYMENT.REFUND_FAILED"),
    data: lightsparkTransactionDataSchema.extend({ status: z.literal("REFUND_FAILED") }),
    timestamp: z.string().trim().min(1).optional(),
  }),
]);

const lightsparkWebhookEnvelopeSchema = z.object({ type: z.string() });
const lightsparkSignatureSchema = z.object({ v: z.literal(1), s: z.string().min(1) }).strict();
type LightsparkWebhook = z.infer<typeof lightsparkWebhookSchema>;

/**
 * Validates a signed Lightspark body as a supported transaction webhook.
 *
 * @param rawBody - The raw request body.
 * @returns The typed Lightspark transaction webhook.
 */
function parseLightsparkJson(rawBody: string): LightsparkWebhook {
  let parsed: ReturnType<typeof JSON.parse>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw badRequest("Lightspark webhook body must be valid JSON", { provider: "lightspark" });
  }

  const envelope = lightsparkWebhookEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw badRequest("Lightspark webhook body must include an event type", {
      provider: "lightspark",
      errors: z.treeifyError(envelope.error),
    });
  }

  const eventType = lightsparkEventTypeSchema.safeParse(envelope.data.type);
  if (!eventType.success) {
    throw badRequest(`Unsupported Lightspark webhook event: ${envelope.data.type}`, {
      provider: "lightspark",
    });
  }

  const webhook = lightsparkWebhookSchema.safeParse(parsed);
  if (!webhook.success) {
    throw badRequest("Invalid Lightspark transaction webhook payload", {
      provider: "lightspark",
      errors: z.treeifyError(webhook.error),
    });
  }
  return webhook.data;
}

/**
 * Selects the provider-reported Solana settlement hash.
 *
 * @param data - The typed Lightspark transaction data.
 * @returns The provider hash when one is present.
 */
function lightsparkOnchainTransfer(
  data: LightsparkWebhook["data"]
): { signature: string } | undefined {
  if (data.reconciliationInstructions !== undefined) {
    return { signature: data.reconciliationInstructions.transactionHash };
  }
  if (data.destination.onChainTransaction !== undefined) {
    return { signature: data.destination.onChainTransaction.transactionHash };
  }
  return undefined;
}

/**
 * Captures terminal Lightspark transaction economics.
 *
 * @param data - The typed Lightspark transaction data.
 * @returns Terminal settlement economics or undefined for an in-flight event.
 */
function buildLightsparkSettlement(
  data: LightsparkWebhook["data"]
): LightsparkRampSettlement | undefined {
  if (
    data.status !== "COMPLETED" &&
    data.status !== "FAILED" &&
    data.status !== "EXPIRED" &&
    data.status !== "REFUND_FAILED"
  ) {
    return undefined;
  }
  return {
    provider: "lightspark",
    status: data.status,
    sentAmount: data.sentAmount,
    receivedAmount: data.receivedAmount,
    exchangeRate: data.exchangeRate,
    fees: data.fees,
    ...(data.settledAt !== undefined && data.settledAt !== null
      ? { settledAt: data.settledAt }
      : {}),
    ...(data.failureReason !== undefined && data.failureReason !== null
      ? { failureReason: data.failureReason }
      : {}),
  };
}

/**
 * Maps a typed Lightspark transaction webhook to the shared settlement event.
 *
 * @param rawBody - The verified raw request body.
 * @returns The shared settlement event.
 */
function parseLightsparkEvent(rawBody: string): RampSettlementEvent {
  const webhook = parseLightsparkJson(rawBody);
  const { data } = webhook;
  const kind = LIGHTSPARK_OUTGOING_PAYMENT_WEBHOOK_TYPES[webhook.type];
  const transferId = data.description.startsWith("xfr_") ? data.description : undefined;
  const onchain = lightsparkOnchainTransfer(data);
  const settlement = buildLightsparkSettlement(data);
  const identity = {
    provider: "lightspark" as const,
    reference: data.quoteId,
    transactionReference: data.id,
    providerCustomerId: data.customerId,
    ...(transferId !== undefined ? { transferId } : {}),
    ...(onchain !== undefined ? { onchain } : {}),
  };

  if (kind === "failed" || kind === "expired") {
    return {
      ...identity,
      kind,
      ...(data.failureReason !== undefined && data.failureReason !== null
        ? { error: data.failureReason }
        : {}),
      ...(settlement !== undefined ? { settlement } : {}),
    };
  }
  if (kind === "settled") {
    return {
      ...identity,
      kind,
      receivedAmount: formatLightsparkAmount(data.receivedAmount),
      ...(settlement !== undefined ? { settlement } : {}),
    };
  }
  return { ...identity, kind };
}

/**
 * Formats a Grid minor-unit amount in display units.
 *
 * @param amount - The Grid amount and decimal metadata.
 * @returns The decimal display amount.
 */
function formatLightsparkAmount(amount: LightsparkGridAmount): string {
  return formatDecimalAmount(BigInt(amount.amount), amount.decimals);
}

export class LightsparkWebhookProcessor implements WebhookProcessor<string, RampSettlementEvent> {
  readonly provider = "lightspark";

  /**
   * Verifies a Grid webhook over the raw request body before the body is parsed as a webhook event.
   *
   * @param context - Webhook headers, raw body, environment, and runtime configuration.
   * @returns The signature-verified raw request body.
   */
  async verify({
    env,
    environment,
    headers,
    rawBody,
  }: RampWebhookValidationContext): Promise<string> {
    const publicKey = requireEnv(
      env,
      environment === "sandbox"
        ? "LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY"
        : "LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY"
    );
    const signatureHeader = headers.get("x-grid-signature")?.trim();
    if (!signatureHeader) {
      throw new AppError("UNAUTHORIZED", "Lightspark webhook is missing x-grid-signature", {
        provider: this.provider,
      });
    }

    let signature = signatureHeader;
    if (signatureHeader.startsWith("{")) {
      let header: ReturnType<typeof JSON.parse>;
      try {
        header = JSON.parse(signatureHeader);
      } catch {
        throw new AppError("UNAUTHORIZED", "Lightspark webhook signature header is malformed", {
          provider: this.provider,
        });
      }
      const parsedHeader = lightsparkSignatureSchema.safeParse(header);
      if (!parsedHeader.success) {
        throw new AppError("UNAUTHORIZED", "Lightspark webhook signature header is malformed", {
          provider: this.provider,
        });
      }
      signature = parsedHeader.data.s;
    }

    const timestampMatch = /"timestamp"\s*:\s*"([^"]+)"/.exec(rawBody);
    const timestamp = timestampMatch?.[1];
    if (!timestamp) {
      throw new AppError("UNAUTHORIZED", "Lightspark webhook is missing timestamp", {
        provider: this.provider,
      });
    }

    await verifyWebhookSignature({
      provider: this.provider,
      signedPayload: rawBody,
      signature,
      algorithm: { type: "ecdsa-sha256", publicKeyPem: publicKey, encoding: "base64" },
      timestampSeconds: Date.parse(timestamp) / 1000,
    });
    return rawBody;
  }

  parse(payload: string): RampSettlementEvent {
    let parsed: ReturnType<typeof JSON.parse>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw badRequest("Lightspark webhook body must be valid JSON", { provider: this.provider });
    }
    const envelope = lightsparkWebhookEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw badRequest("Lightspark webhook body must include an event type", {
        provider: this.provider,
        errors: z.treeifyError(envelope.error),
      });
    }
    const known = lightsparkEventTypeSchema.safeParse(envelope.data.type);
    if (!known.success) {
      return {
        provider: this.provider,
        kind: "ignore",
        reason: `unsupported_event:${envelope.data.type}`,
      };
    }
    return parseLightsparkEvent(payload);
  }

  async process(c: AppContext, _environment: SdpEnvironment, event: RampSettlementEvent) {
    if (event.kind === "ignore") {
      getLogger().info(`[lightspark webhook] ignored event: ${event.reason}`);
      return;
    }

    const repository = createSystemPaymentsRepository(c.env);
    // Every identifier the event carries resolves independently, and settlement
    // requires them to agree: the description (operator-writable text, so the
    // weakest identifier), the Grid transaction id (the promoted
    // provider_reference), and the Grid quote id (the reference the transfer
    // row was created with). Any two identifiers naming different transfers,
    // or a description-only match no reference corroborates, settle nothing.
    const descriptionMatch = event.transferId
      ? await repository.getTransferById({ transferId: event.transferId })
      : null;
    if (descriptionMatch !== null && descriptionMatch.provider !== this.provider) {
      logEvent("warn", {
        event: "sdp_api_lightspark_transfer_provider_mismatch",
        flow: "ramp-settlement",
        transfer_id: descriptionMatch.id,
        transfer_provider: descriptionMatch.provider,
        provider: this.provider,
        provider_reference: event.reference,
      });
      return;
    }
    const transactionMatch = event.transactionReference
      ? await repository.getTransferByProviderReference({
          provider: this.provider,
          providerReference: event.transactionReference,
        })
      : null;
    const quoteMatch = await repository.getTransferByProviderReference({
      provider: this.provider,
      providerReference: event.reference,
    });
    const matches = [descriptionMatch, transactionMatch, quoteMatch].filter(
      (candidate) => candidate !== null
    );
    const matchedIds = new Set(matches.map((candidate) => candidate.id));
    if (matchedIds.size > 1) {
      logEvent("warn", {
        event: "sdp_api_lightspark_conflicting_event_identifiers",
        flow: "ramp-settlement",
        provider: this.provider,
        matched_transfer_ids: [...matchedIds],
        event_transfer_id: event.transferId,
        event_quote_id: event.reference,
        event_transaction_id: event.transactionReference,
      });
      return;
    }
    const transfer = matches.length > 0 ? matches[0] : null;
    if (
      transfer !== null &&
      transfer.provider_reference !== event.reference &&
      transfer.provider_reference !== event.transactionReference
    ) {
      logEvent("warn", {
        event: "sdp_api_lightspark_quote_reference_mismatch",
        flow: "ramp-settlement",
        organization_id: transfer.organization_id,
        project_id: transfer.project_id,
        transfer_id: transfer.id,
        provider: this.provider,
        transfer_provider_reference: transfer.provider_reference,
        event_quote_id: event.reference,
        event_transaction_id: event.transactionReference,
      });
      return;
    }
    if (transfer === null) {
      logEvent("info", {
        event: "sdp_api_lightspark_unmatched_transaction",
        flow: "ramp-settlement",
        provider: this.provider,
        provider_reference: event.reference,
        transfer_id: event.transferId,
      });
      return;
    }

    const onchain = event.onchain
      ? {
          ...event.onchain,
          ...(transfer.type === "onramp" && transfer.destination_address !== null
            ? { destinationAddress: transfer.destination_address }
            : {}),
          ...(transfer.type === "offramp" && transfer.source_address !== null
            ? { sourceAddress: transfer.source_address }
            : {}),
        }
      : undefined;
    await applyRampSettlementEvent(c.env, {
      ...event,
      transferId: transfer.id,
      ...(onchain !== undefined ? { onchain } : {}),
    });
  }
}
