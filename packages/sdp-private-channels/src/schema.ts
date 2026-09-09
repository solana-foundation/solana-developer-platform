import type { PrivateChannelInstanceInput } from "@sdp/types";
import { z } from "zod";

// Solana base58 pubkey: same regex used across the SDP codebase (see
// apps/sdp-web/src/app/dashboard/custody/actions.ts:9).
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrl = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine(isHttpUrl, `${label} must be a valid http/https URL.`);

const base58Address = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .regex(BASE58_PUBKEY_RE, `${label} must be a base58 Solana address.`);

/**
 * Single source of truth for validating the private-channel connect form.
 * The API handler and the client form both call `.safeParse` on this schema.
 *
 * `authUrl` is required — SPC's member and wallet-verification model both
 * depend on the auth service, so an instance without one is not permitted.
 */
export const privateChannelInstanceInputSchema = z.object({
  gatewayUrl: httpUrl("Gateway URL"),
  // Transitional expand/contract compatibility: current `main` still sends
  // this field, while the migrated UI omits it. New rows persist and return an
  // explicit empty string, so response parsing must accept both that value and
  // a real legacy URL. It is never used for RPC execution.
  chainRpcUrl: z
    .union([httpUrl("Chain RPC URL"), z.literal("")])
    .optional()
    .default(""),
  escrowProgramId: base58Address("Escrow program ID"),
  withdrawProgramId: base58Address("Withdraw program ID"),
  escrowInstanceAddr: base58Address("Escrow instance address"),
  authUrl: httpUrl("Auth URL"),
}) satisfies z.ZodType<PrivateChannelInstanceInput>;

export type PrivateChannelInstanceInputSchema = typeof privateChannelInstanceInputSchema;
