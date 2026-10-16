import type { RampProviderWebhook, RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { RampWebhookBusinessOutcome, SdpEnvironment } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export class TerminalRampWebhookError extends Error {}

export interface WebhookProcessor<Payload = unknown, Event = unknown>
  extends RampProviderWebhook<Event> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<Payload>;
  parse(payload: Payload | string, environment?: SdpEnvironment): Event;
  process(env: Env, environment: SdpEnvironment, event: Event): Promise<RampWebhookBusinessOutcome>;
}
