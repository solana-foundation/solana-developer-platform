import type { RampProviderId } from "@sdp/types/provider-access";
import { badRequest } from "@/lib/errors";
import { moonpayWebhook } from "./moonpay";
import type { WebhookProcessor } from "./processor";
import { stripeWebhook } from "./stripe";

export const RAMP_PROVIDER_WEBHOOK_PROCESSOR = {
  moonpay: moonpayWebhook,
  stripe: stripeWebhook,
} as const satisfies Record<RampProviderId, WebhookProcessor<unknown>>;

export type WebhookRampProvider = keyof typeof RAMP_PROVIDER_WEBHOOK_PROCESSOR;

export function isWebhookRampProvider(value: string): value is WebhookRampProvider {
  return Object.hasOwn(RAMP_PROVIDER_WEBHOOK_PROCESSOR, value);
}

export function parseRampWebhookProvider(value: string | undefined): WebhookRampProvider {
  if (value !== undefined && isWebhookRampProvider(value)) {
    return value;
  }
  throw badRequest("Unsupported ramp webhook provider");
}
