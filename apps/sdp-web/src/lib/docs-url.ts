import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";

/**
 * Resolves the documentation origin, and optionally a path within it.
 *
 * The same env-or-fallback expression had been copied into four places, so a
 * change to how docs are addressed had four sites to keep in step and no way to
 * tell they had drifted. Two of those copies live in issuance and are left alone
 * while that module is in progress.
 *
 * `NEXT_PUBLIC_SDP_DOCS_URL` is read as a literal member expression rather than
 * through a variable, because Next inlines that form at build time.
 */
export function resolveDocsUrl(path?: string): string {
  const origin = (
    process.env.NEXT_PUBLIC_SDP_DOCS_URL ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3001/docs" : DEFAULT_SDP_DOCS_URL)
  ).replace(/\/+$/, "");

  if (!path) {
    return origin;
  }

  return `${origin}/${path.replace(/^\/+/, "")}`;
}
