import { z } from "zod";
import type { CountryCode } from "./countries";
import { SDP_TERMS_MARKDOWN } from "./sdp-terms-text";

/** One block of a terms section: a paragraph, a subsection's heading, or a bulleted list. */
export const sdpTermsBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraph"), text: z.string() }),
  z.object({ kind: z.literal("subheading"), text: z.string() }),
  z.object({ kind: z.literal("list"), items: z.array(z.string()).readonly() }),
]);
export type SdpTermsBlock = z.infer<typeof sdpTermsBlockSchema>;

export interface SdpTermsSection {
  heading: string;
  blocks: readonly SdpTermsBlock[];
}

/** A run of terms text: `**…**` in the source marks the bold runs. */
export interface SdpTermsRun {
  text: string;
  bold: boolean;
}

/** Splits a paragraph or list item of `SDP_TERMS_MARKDOWN` into plain and bold runs. */
export function sdpTermsRuns(text: string): SdpTermsRun[] {
  return text
    .split("**")
    .map((run, index) => ({ text: run, bold: index % 2 === 1 }))
    .filter((run) => run.text !== "");
}

/**
 * Reads the Markdown subset `SDP_TERMS_MARKDOWN` is written in: `## ` opens a section, `### ` a
 * subheading, a run of `- ` lines one list, and any other line a paragraph. A blank line ends a
 * list.
 */
export function parseSdpTermsMarkdown(markdown: string): SdpTermsSection[] {
  const sections: { heading: string; blocks: SdpTermsBlock[] }[] = [];
  let list: string[] | null = null;
  for (const line of markdown.split("\n")) {
    if (line.trim() === "") {
      list = null;
      continue;
    }
    if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3), blocks: [] });
      list = null;
      continue;
    }
    const section = sections.at(-1);
    if (section === undefined) throw new Error("SDP terms text must open with a ## section");
    if (line.startsWith("### ")) {
      section.blocks.push({ kind: "subheading", text: line.slice(4) });
      list = null;
    } else if (line.startsWith("- ")) {
      if (list === null) {
        list = [];
        section.blocks.push({ kind: "list", items: list });
      }
      list.push(line.slice(2));
    } else {
      section.blocks.push({ kind: "paragraph", text: line });
      list = null;
    }
  }
  return sections;
}

/**
 * The SDP Terms of Use: the text the public `/terms` page and the mainnet access request
 * (HOO-2427) show, and the version the API records when an organization accepts them. A request
 * naming any other version is refused, so an admin always agrees to this text. Legal's text is
 * binding in English, so it is not a translated catalog.
 *
 * Changing a word means a new `version`: `apps/sdp-api/src/services/sdp-terms.test.ts` pins each
 * version to a hash of its text.
 */
export const SDP_TERMS: {
  version: string;
  title: string;
  effectiveDate: string;
  sections: readonly SdpTermsSection[];
} = {
  version: "2026-11-03",
  title: "Terms of Use",
  effectiveDate: "Last Modified: November 3, 2026",
  sections: parseSdpTermsMarkdown(SDP_TERMS_MARKDOWN),
};

/**
 * The Solana Foundation's email domain. A mainnet request names its Foundation contact (PRO-2481)
 * only by an address here, so the reviewer can reach someone who knows the requester, and the
 * field never names an outside address.
 */
export const SOLANA_FOUNDATION_EMAIL_DOMAIN = "solana.org";

/** The longest "what are you building" line a mainnet request carries (PRO-2481). */
export const MAINNET_USE_CASE_MAX_LENGTH = 150;

/** The requester's Solana Foundation contact: an address at {@link SOLANA_FOUNDATION_EMAIL_DOMAIN}. */
export const foundationContactEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .refine((email) => email.endsWith(`@${SOLANA_FOUNDATION_EMAIL_DOMAIN}`), {
    message: `Enter a Solana Foundation address ending in @${SOLANA_FOUNDATION_EMAIL_DOMAIN}`,
  });

/** What the organization says it is building, in one short line. */
export const mainnetUseCaseSchema = z.string().trim().min(1).max(MAINNET_USE_CASE_MAX_LENGTH);

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
