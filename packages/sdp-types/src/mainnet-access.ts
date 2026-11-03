import type { CountryCode } from "./countries";

export interface SdpTermsSection {
  heading: string;
  paragraphs: readonly string[];
}

/**
 * The SDP Terms and Conditions an organization accepts when it asks for mainnet (HOO-2427): the
 * text the dashboard shows and the version the API records, held together. A request naming any
 * other version is refused, so an admin always agrees to this text. Legal's text is binding in
 * English, so it is not a translated catalog.
 *
 * Changing a word means a new `version`: `apps/sdp-api/src/services/sdp-terms.test.ts` pins each
 * version to a hash of its text.
 *
 * PLACEHOLDER until Legal's draft lands.
 */
export const SDP_TERMS: {
  version: string;
  title: string;
  effectiveDate: string;
  sections: readonly SdpTermsSection[];
} = {
  version: "2026-10-placeholder",
  title: "Solana Developer Platform Terms and Conditions",
  effectiveDate: "Draft",
  sections: [
    {
      heading: "Placeholder",
      paragraphs: [
        "This is placeholder text. The final Terms and Conditions from Solana Foundation Legal replace it before launch. Do not rely on this text.",
      ],
    },
    {
      heading: "1. The service",
      paragraphs: [
        "The Solana Developer Platform (SDP) gives your organization APIs and a dashboard for wallets, payments and token operations on the Solana network. Sandbox runs on devnet; mainnet moves real assets.",
        "Mainnet access is granted to your organization at SDP's discretion, after it reviews your request.",
      ],
    },
    {
      heading: "2. Your organization",
      paragraphs: [
        "You confirm that you are authorized to accept these terms on behalf of your organization, and that the jurisdiction you declared is your organization's primary registered geography for business.",
        "You are responsible for the people and API keys you give access to, and for keeping your credentials secure.",
      ],
    },
    {
      heading: "3. Acceptable use",
      paragraphs: [
        "You will use SDP only in compliance with the laws and regulations that apply to your organization and its customers, including sanctions, anti-money-laundering and consumer protection laws.",
        "You will not use SDP to move assets for, or on behalf of, any person or jurisdiction subject to sanctions.",
      ],
    },
    {
      heading: "4. Third-party providers",
      paragraphs: [
        "Some features rely on custody, ramp, compliance and other providers that you contract with directly. Their terms govern your use of their services.",
      ],
    },
    {
      heading: "5. Transactions on Solana",
      paragraphs: [
        "Transactions submitted to the Solana network are final once confirmed and cannot be reversed by SDP. You are responsible for verifying addresses and amounts before you submit them.",
      ],
    },
    {
      heading: "6. Changes and termination",
      paragraphs: [
        "SDP may update these terms. When it does, it publishes a new version, and continued use of mainnet may require you to accept it.",
        "SDP may suspend or end your organization's access if you breach these terms or if required by law.",
      ],
    },
    {
      heading: "7. Disclaimers and liability",
      paragraphs: [
        "SDP is provided as is. To the fullest extent the law allows, the Solana Foundation disclaims all warranties and is not liable for indirect or consequential losses.",
      ],
    },
  ],
};

/**
 * Where an organization's mainnet access stands. `approved` is the
 * `enableProductionProject` entitlement an operator sets in Clerk, whether or
 * not the organization ever asked; `pending` is a request sent and not yet
 * approved.
 */
export const MAINNET_ACCESS_STATES = ["not_requested", "pending", "approved"] as const;
export type MainnetAccessState = (typeof MAINNET_ACCESS_STATES)[number];

export type MainnetAccessRequest = {
  requestedAt: string;
  requestedByUserId: string;
  /** The Terms and Conditions version the requester accepted with the request. */
  termsVersion: string;
  /** False when the email to the SDP alias has not gone out yet; `POST …/notify` sends it. */
  notified: boolean;
};

/** `GET /v1/organizations/{orgId}/mainnet-access`. */
export type MainnetAccess = {
  state: MainnetAccessState;
  /** Whether this deployment takes requests; false while its request email is not configured. */
  available: boolean;
  /** Self-declared; SDP does not verify it. */
  countryCode: CountryCode | null;
  request: MainnetAccessRequest | null;
  /** The SDP alias an admin writes to for a change; null where the deployment sets none. */
  contactEmail: string | null;
};
