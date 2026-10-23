import { DEFAULT_SDP_AI_LLMS_URL, DEFAULT_SDP_DOCS_URL } from "@sdp/types/site";
import { AUTH_ENTRY_PATH } from "@/lib/auth-entry";
import { resolveDocsUrl } from "@/lib/docs-url";

/** Where a signed-in visitor goes instead of the sign-in and sign-up forms. */
export const DASHBOARD_PATH = "/dashboard";

/**
 * Where each section's "more" link opens. Fixed product routes, whatever the signup state: a
 * signed-out visitor is sent through sign-in by the dashboard's own guard.
 */
export const SECTION_LINKS = {
  issuance: "/dashboard/issuance",
  payments: "/dashboard/payments/pay",
  markets: "/dashboard/markets",
  // TODO: no page, redirect or rewrite serves /policies yet, so this link ends on a missing page
  // after sign-in. Point it at the policy documentation or create the page.
  policies: "/policies",
} as const;

/** The waitlist form; signups go here while open signup is off. */
export const waitlistHref = "https://solanafoundation.typeform.com/to/PLfMTDQs";

/** The API reference, generated from the OpenAPI document. */
const OPENAPI_PATH = "reference/api";

/**
 * llms.txt, as a path under the docs origin. It comes from the shared site constant, but resolves
 * through `resolveDocsUrl` so a dev or preview docs origin (`NEXT_PUBLIC_SDP_DOCS_URL`) is kept.
 */
const LLMS_PATH = DEFAULT_SDP_AI_LLMS_URL.slice(DEFAULT_SDP_DOCS_URL.length);

/** The homepage's sign-up call to action: the account form, or the waitlist while signup is closed. */
export type SignupLink = {
  href: string;
  label: string;
  /** Opens in a new tab (the waitlist form is off-site). */
  external: boolean;
};

export type HomepageLinks = {
  signup: SignupLink;
  signIn: string;
  /** The visitor has a session: `signup` and `signIn` both open the dashboard. */
  signedIn?: boolean;
  docs: string;
  /** The API reference. */
  openapi: string;
  /** The docs' llms.txt. */
  llms: string;
};

/** The attributes a link opens with: off-site ones open in a new tab. */
export function externalLinkProps(external = false) {
  return {
    target: external ? "_blank" : undefined,
    rel: external ? "noreferrer" : undefined,
  };
}

/** Where the homepage's account call to action leads: the dashboard, the sign-up form, or the waitlist. */
type AccountEntry = "dashboard" | "signup" | "waitlist";

/** A session wins; otherwise the `homepageOpenSignup` flag picks the sign-up form or the waitlist. */
function accountEntry({
  signedIn,
  openSignup,
}: {
  signedIn: boolean;
  openSignup: boolean;
}): AccountEntry {
  if (signedIn) return "dashboard";
  return openSignup ? "signup" : "waitlist";
}

/**
 * Every link the homepage points into the product with. A signed-in visitor is sent to the
 * dashboard; otherwise the `homepageOpenSignup` flag decides whether "Create account" opens the
 * sign-up form or the waitlist.
 */
export function resolveHomepageLinks({
  signedIn = false,
  openSignup,
  createAccountLabel,
  joinWaitlistLabel,
  dashboardLabel,
}: {
  signedIn?: boolean;
  openSignup: boolean;
  createAccountLabel: string;
  joinWaitlistLabel: string;
  dashboardLabel: string;
}): HomepageLinks {
  let signup: SignupLink;
  const entry = accountEntry({ signedIn, openSignup });
  switch (entry) {
    case "dashboard":
      signup = { href: DASHBOARD_PATH, label: dashboardLabel, external: false };
      break;
    case "signup":
      signup = { href: "/sign-up", label: createAccountLabel, external: false };
      break;
    case "waitlist":
      signup = { href: waitlistHref, label: joinWaitlistLabel, external: true };
      break;
    default: {
      const exhaustive: never = entry;
      throw new Error(`Unknown homepage account entry: ${exhaustive}`);
    }
  }
  return {
    signup,
    signIn: signedIn ? DASHBOARD_PATH : AUTH_ENTRY_PATH,
    signedIn,
    docs: resolveDocsUrl(),
    openapi: resolveDocsUrl(OPENAPI_PATH),
    llms: resolveDocsUrl(LLMS_PATH),
  };
}
