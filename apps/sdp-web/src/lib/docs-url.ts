import { DEFAULT_SDP_DOCS_URL } from "@sdp/types";

/**
 * Resolves the documentation origin, and optionally a path within it.
 *
 * Every docs link in the dashboard goes through here, so a change to how docs
 * are addressed has one site to update instead of several that can drift.
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
