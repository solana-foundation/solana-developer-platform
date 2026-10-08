import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { type AdmittedMovement, assertAdmittedMovement } from "@/lib/admit-movement";
import { AppError } from "@/lib/errors";

type BvnkOnrampPayoutInput = Parameters<typeof RAMP_PROVIDER_CLIENTS.bvnk.createOnrampPayout>[1];

/**
 * The only path to a BVNK on-ramp payout (HOO-1955). The client lives in
 * `@sdp/payments`, which cannot depend on the API's admission token, so the
 * sink is this API-local wrapper and the conformance test refuses a direct
 * `.createOnrampPayout(` call anywhere else.
 */
export function createAdmittedBvnkOnrampPayout(
  movement: AdmittedMovement,
  ctx: RampRuntimeContext,
  input: BvnkOnrampPayoutInput
) {
  assertAdmittedMovement(movement);
  if (movement.purpose !== "ramps.bvnk_onramp_payout") {
    throw new AppError("INTERNAL_ERROR", "BVNK payout requires a BVNK payout admission");
  }
  return RAMP_PROVIDER_CLIENTS.bvnk.createOnrampPayout(ctx, input);
}
