import { CUSTODY_PROVIDERS } from "@sdp/custody";
import { z } from "zod";

export const completeOnboardingSchema = z.strictObject({
  custodyProvider: z.enum(CUSTODY_PROVIDERS),
});
