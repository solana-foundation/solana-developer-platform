import type { SdpEnvironment } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import type { RampWebhookValidationContext } from "@/lib/ramps/types";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export interface WebhookProcessor<Payload = unknown, Event = unknown> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<Payload>;
  parse(payload: Payload): Event;
  process(c: AppContext, environment: SdpEnvironment, event: Event): Promise<void>;
}
