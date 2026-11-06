/**
 * Only this branch's Vercel preview may stage unpublished Earn docs.
 * @param {Record<string, string | undefined>} [env]
 */
export function isEarnDocsPreview(env = process.env) {
  return env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === "earn-docs";
}

/**
 * Preview discovery links must stay on the deployment that serves Earn.
 * @param {Record<string, string | undefined>} [env]
 */
export function earnDocsPreviewOrigin(env = process.env) {
  if (!isEarnDocsPreview(env)) return undefined;
  if (!env.VERCEL_URL) throw new Error("VERCEL_URL is required for the Earn docs preview");
  const url = new URL(`https://${env.VERCEL_URL}`);
  if (url.host !== env.VERCEL_URL || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("VERCEL_URL must be the Earn preview deployment's hostname");
  }
  return url.origin;
}
