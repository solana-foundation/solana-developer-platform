export const SIGN_IN_PATH = "/sign-in";

export function signInHref(returnTo: string): string {
  return `${SIGN_IN_PATH}?${new URLSearchParams({ redirect_url: returnTo })}`;
}

export const SIGN_UP_PATH = "/sign-up";

// Clerk always allows a redirect back to the page's own origin. Left empty or unset, it also allows
// every subdomain of the Clerk domain's parent, so the list stays non-empty to keep redirects on SDP.
export const SIGN_IN_REDIRECT_ORIGINS = ["https://platform.solana.com"];
