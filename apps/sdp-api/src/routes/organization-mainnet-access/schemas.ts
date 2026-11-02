import { COUNTRY_CODES } from "@sdp/types/countries";
import { z } from "zod";

/**
 * The one-time mainnet access request (HOO-2427): the organization's jurisdiction and the
 * Terms and Conditions version the admin read and accepted, in one submit.
 */
export const requestMainnetAccessSchema = z.strictObject({
  countryCode: z.enum(COUNTRY_CODES),
  termsVersion: z.string().min(1).max(64),
  acceptTerms: z.literal(true),
});
