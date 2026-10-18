import type { RampProviderWebhook, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { RampWebhookProcessResult } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export class TerminalRampWebhookError extends Error {}

export interface WebhookProcessor<Event = unknown> extends RampProviderWebhook<Event> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<string>;
  process(env: Env, environment: SdpEnvironment, event: Event): Promise<RampWebhookProcessResult>;
}
