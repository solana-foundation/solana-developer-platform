import type { RampProviderId } from "@sdp/types/provider-access";
import { badRequest } from "@/lib/errors";
import { MoonpayWebhookProcessor } from "./moonpay";
import type { WebhookProcessor } from "./processor";
import { StripeWebhookProcessor } from "./stripe";

export const RAMP_PROVIDER_WEBHOOK_PROCESSOR = {
  moonpay: new MoonpayWebhookProcessor(),
  stripe: new StripeWebhookProcessor(),
} as const satisfies Record<RampProviderId, WebhookProcessor<unknown, unknown>>;

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
