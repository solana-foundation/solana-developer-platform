import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { SdpEnvironment } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export class TerminalRampWebhookError extends Error {}

/**
 * A policy deferral, not a processing failure: the event is verifiably real
 * but cannot apply yet, and only an external state change — e.g. a cached
 * compliance decision clearing — can unblock it. The inbox row stays `pending`
 * with its attempt budget restored, so the replay keeps retrying it until that
 * state arrives. It must never park as `failed`: nothing but the unblocking
 * state can apply it, and the row is the only record of the provider's signed
 * signal.
 */
export class DeferrableRampWebhookError extends Error {}

export interface WebhookProcessor<Payload = unknown, Event = unknown> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<Payload>;
  parse(payload: Payload): Event;
  process(env: Env, environment: SdpEnvironment, event: Event): Promise<void>;
}
