// The grid ⇄ list preference for the issuance overview.
//
// It lives in a cookie rather than localStorage because both things that paint
// this route are rendered on the server: the page itself, and the Suspense
// fallback in (overview)/loading.tsx. Neither can read localStorage, so a
// client-only preference forced them to assume "grid" and then swap to rows once
// the real list hydrated — a grid skeleton followed by a grid→list cross-fade,
// every load, for anyone who had chosen rows. The cookie is read in the dashboard
// layout and seeded into the workspace context, so the first paint is already the
// view the user picked.
export type TokenView = "grid" | "list";

export const ISSUANCE_TOKEN_VIEW_COOKIE = "sdp_issuance_token_view";

export const DEFAULT_ISSUANCE_TOKEN_VIEW: TokenView = "grid";

// A year, matching PROJECT_COOKIE_OPTIONS — a view preference has no reason to
// expire sooner than the project selection sitting beside it.
const VIEW_COOKIE_MAX_AGE_SECONDS = 31_536_000;

export function parseIssuanceTokenView(value: string | null | undefined): TokenView {
  return value === "grid" || value === "list" ? value : DEFAULT_ISSUANCE_TOKEN_VIEW;
}

// Written from the client rather than through a server action: the toggle is a
// local preference, and a round-trip would stall a switch that is otherwise pure
// client state. Not `httpOnly` for the same reason — the writer is the browser.
export function persistIssuanceTokenView(view: TokenView): void {
  if (typeof document === "undefined") {
    return;
  }

  const secure = window.location.protocol === "https:" ? "; secure" : "";
  // biome-ignore lint/suspicious/noDocumentCookie: the suggested Cookie Store API is unsupported in Safari.
  document.cookie = `${ISSUANCE_TOKEN_VIEW_COOKIE}=${view}; path=/; max-age=${VIEW_COOKIE_MAX_AGE_SECONDS}; samesite=lax${secure}`;
}
