import { COUNTRY_CODES } from "@sdp/types/countries";
import { foundationContactEmailSchema, mainnetUseCaseSchema } from "@sdp/types/mainnet-access";
import { z } from "zod";

/**
 * The one-time mainnet access request (HOO-2427): the organization's jurisdiction and the
 * Terms and Conditions version the admin read and accepted, in one submit. The Foundation contact
 * and the line about what the organization builds (PRO-2481) are optional: absent or null when
 * the admin gave none.
 */
export const requestMainnetAccessSchema = z.strictObject({
  countryCode: z.enum(COUNTRY_CODES),
  termsVersion: z.string().min(1).max(64),
  acceptTerms: z.literal(true),
  foundationContactEmail: foundationContactEmailSchema.nullish(),
  useCase: mainnetUseCaseSchema.nullish(),
});
