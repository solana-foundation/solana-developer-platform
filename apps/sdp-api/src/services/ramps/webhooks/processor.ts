import type { RampProviderWebhook } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { RampWebhookProcessResult } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Env } from "@/types/env";

export class TerminalRampWebhookError extends Error {}

/** What a processor verifies a delivery against. */
export interface RampWebhookValidationContext {
  env: Record<string, string | undefined>;
  environment: SdpEnvironment;
  headers: Headers;
  rawBody: string;
  requestUrl?: string;
}

export interface WebhookProcessor<Event = unknown> extends RampProviderWebhook<Event> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<string>;
  process(env: Env, environment: SdpEnvironment, event: Event): Promise<RampWebhookProcessResult>;
}
