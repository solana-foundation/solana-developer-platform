import { SDP_TERMS } from "@sdp/types/mainnet-access";

export interface SdpTermsSection {
  heading: string;
  paragraphs: readonly string[];
}

export interface SdpTermsDocument {
  version: string;
  title: string;
  effectiveDate: string;
  sections: readonly SdpTermsSection[];
}

/**
 * The SDP Terms and Conditions an admin reads before asking for mainnet (HOO-2427), keyed by
 * the version the API accepts (`SDP_TERMS.version` in `@sdp/types/mainnet-access`). Legal's
 * text is binding in English, so it is not a translated catalog.
 *
 * PLACEHOLDER until Legal's draft lands: replace this document and bump `SDP_TERMS` with it.
 */
export const SDP_TERMS_DOCUMENT: SdpTermsDocument = {
  version: SDP_TERMS.version,
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
