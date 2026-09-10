import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";
import { canonicalizeIpAllowlistEntry } from "@/lib/ip-allowlist";

/** Rebuilt per authenticated request, so bounded; 100 dwarfs any real footprint. */
export const MAX_ORGANIZATION_ALLOWED_IPS = 100;

/**
 * Validates and canonicalizes in one pass: an invalid stored entry fails the
 * whole allowlist closed at request time, and the write is the only moment the
 * operator is here to fix it. Canonical form because `203.0.113.5/24` reads as
 * one host but authorizes 256 — the stored list must say what it grants.
 */
const organizationAllowedIpSchema = z.string().transform((value, ctx) => {
  const canonical = canonicalizeIpAllowlistEntry(value);
  if (canonical === null) {
    ctx.addIssue({
      code: "custom",
      message: "Must be a valid IPv4 or IPv6 address or CIDR range",
    });
    return z.NEVER;
  }
  return canonical;
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z
    .object({
      rpcProvider: z.enum(ORGANIZATION_RPC_PROVIDERS).optional(),
      defaultEnvironment: z.enum(["sandbox", "production"]).optional(),
      allowedIpAddresses: z
        .array(organizationAllowedIpSchema)
        .max(MAX_ORGANIZATION_ALLOWED_IPS)
        .transform((entries) => [...new Set(entries)])
        .optional(),
    })
    .optional(),
});
