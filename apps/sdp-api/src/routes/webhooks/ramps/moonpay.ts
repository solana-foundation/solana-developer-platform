import type { Context } from "hono";
import { RAMP_PROVIDER_CLIENTS } from "@/lib/ramps";
import type { Env } from "@/types/env";
import { applyRampSettlementEvent } from "./settlements";

type AppContext = Context<{ Bindings: Env }>;

export async function handleMoonpayRampWebhook(c: AppContext, payload: unknown): Promise<void> {
  const event = RAMP_PROVIDER_CLIENTS.moonpay.parseSettlementEvent(payload);
  if (event.kind === "ignore") {
    console.log(`[moonpay webhook] ignored event: ${event.reason}`);
    return;
  }
  await applyRampSettlementEvent(c, event);
}
