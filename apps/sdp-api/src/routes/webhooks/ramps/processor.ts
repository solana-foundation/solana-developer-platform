import type { RampWebhookValidationContext } from "@sdp/payments/ramps/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Context } from "hono";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export class TerminalRampWebhookError extends Error {}

export interface WebhookProcessor<Payload = unknown, Event = unknown> {
  readonly provider: RampProviderId;
  verify(context: RampWebhookValidationContext): Promise<Payload>;
  parse(payload: Payload): Event;
  /**
   * Applies a parsed event under the cluster scope its entry point opened (the webhook handler
   * from the URL's environment, the replay job from the stored row's).
   *
   * @param env - Process environment used for repository and provider access.
   * @param event - The parsed event.
   * @returns Resolves once the event is applied.
   */
  process(env: Env, event: Event): Promise<void>;
}
