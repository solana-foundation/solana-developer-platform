export const SIGN_IN_PATH = "/sign-in";

export function signInHref(returnTo: string): string {
  return `${SIGN_IN_PATH}?${new URLSearchParams({ redirect_url: returnTo })}`;
}

export const SIGN_UP_PATH = "/sign-up";

export const ALLOWED_SATELLITE_REDIRECT_ORIGINS = [
  "https://ecosystem.solana.com",
  "https://bookface-git-main-solana-foundation.vercel.app",
];
