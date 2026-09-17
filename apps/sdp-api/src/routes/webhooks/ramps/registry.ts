import type { RampProviderId } from "@sdp/types/provider-access";
import { badRequest } from "@/lib/errors";
import { BvnkWebhookProcessor } from "./bvnk";
import { CoinbaseWebhookProcessor } from "./coinbase";
import { HercleWebhookProcessor } from "./hercle";
import { LightsparkWebhookProcessor } from "./lightspark";
import { MoonpayWebhookProcessor } from "./moonpay";
import { MuralWebhookProcessor } from "./mural";
import type { WebhookProcessor } from "./processor";
import { StripeWebhookProcessor } from "./stripe";

export const RAMP_PROVIDER_WEBHOOK_PROCESSOR = {
  moonpay: new MoonpayWebhookProcessor(),
  lightspark: new LightsparkWebhookProcessor(),
  bvnk: new BvnkWebhookProcessor(),
  coinbase: new CoinbaseWebhookProcessor(),
  mural: new MuralWebhookProcessor(),
  stripe: new StripeWebhookProcessor(),
  hercle: new HercleWebhookProcessor(),
} as const satisfies Record<
  Exclude<RampProviderId, "moneygram">,
  WebhookProcessor<unknown, unknown>
>;

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
