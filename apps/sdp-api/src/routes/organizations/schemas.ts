import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";
import { isValidIpAllowlistEntry } from "@/lib/ip-allowlist";

/** Rebuilt per authenticated request, so bounded; 100 dwarfs any real footprint. */
export const MAX_ORGANIZATION_ALLOWED_IPS = 100;

const organizationAllowedIpSchema = z.string().refine(isValidIpAllowlistEntry, {
  message: "Must be a valid IPv4 or IPv6 address or CIDR range",
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z
    .object({
      rpcProvider: z.enum(ORGANIZATION_RPC_PROVIDERS).optional(),
      defaultEnvironment: z.enum(["sandbox", "production"]).optional(),
      // An invalid stored entry fails the whole allowlist closed at request
      // time; the write is the only moment the operator is here to fix it.
      allowedIpAddresses: z
        .array(organizationAllowedIpSchema)
        .max(MAX_ORGANIZATION_ALLOWED_IPS)
        .optional(),
    })
    .optional(),
});
