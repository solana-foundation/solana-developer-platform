import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";
import { isValidIpAllowlistEntry } from "@/lib/ip-allowlist";

/**
 * Every authenticated request rebuilds the allowlist to check its origin
 * against, so the list is bounded. 100 entries is far above any real
 * office-and-VPN footprint and well below a cost worth worrying about.
 */
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
      // Validated rather than accepted as free text: an unparseable entry makes
      // the whole allowlist fail closed at request time, so the write is the
      // only point at which it can be rejected while the operator is still here
      // to correct it.
      allowedIpAddresses: z
        .array(organizationAllowedIpSchema)
        .max(MAX_ORGANIZATION_ALLOWED_IPS)
        .optional(),
    })
    .optional(),
});
