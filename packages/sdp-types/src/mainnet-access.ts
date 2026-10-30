import type { CountryCode } from "./countries";

/**
 * The SDP Terms and Conditions an organization accepts when it asks for
 * mainnet (HOO-2427). The acceptance records the version it accepted, and a
 * request naming any other version is refused, so an admin always agrees to
 * the text the API holds.
 *
 * PLACEHOLDER until Legal's text lands: swap `version` and `url` together.
 */
export const SDP_TERMS = {
  version: "2026-10-placeholder",
  url: "https://platform.solana.com/terms",
} as const;

export type SdpTermsVersion = typeof SDP_TERMS.version;

/**
 * Where an organization's mainnet access stands. `approved` is the
 * `enableProductionProject` entitlement an operator sets in Clerk, whether or
 * not the organization ever asked; `pending` is a request sent and not yet
 * approved.
 */
export const MAINNET_ACCESS_STATES = ["not_requested", "pending", "approved"] as const;
export type MainnetAccessState = (typeof MAINNET_ACCESS_STATES)[number];

export type MainnetTermsAcceptance = {
  version: string;
  acceptedAt: string;
  acceptedByUserId: string;
};

export type MainnetAccessRequest = {
  requestedAt: string;
  requestedByUserId: string;
  /** False when the email to the SDP alias has not gone out yet; submitting again resends it. */
  notified: boolean;
};

/** `GET /v1/organizations/{orgId}/mainnet-access`. */
export type MainnetAccess = {
  state: MainnetAccessState;
  /** Self-declared; SDP does not verify it. */
  countryCode: CountryCode | null;
  termsAcceptance: MainnetTermsAcceptance | null;
  request: MainnetAccessRequest | null;
  currentTerms: { version: string; url: string };
  /** The SDP alias an admin writes to for a change; null where the deployment sets none. */
  contactEmail: string | null;
};
