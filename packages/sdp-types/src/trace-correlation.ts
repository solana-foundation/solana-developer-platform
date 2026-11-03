const WEB_TRACE_ID_PATTERN = /^web_[0-9a-f]{32}$/;

/** Hash only server-generated web trace IDs before they enter shared API logs. */
export async function hashWebTraceId(value: string | null | undefined): Promise<string | null> {
  if (!value || !WEB_TRACE_ID_PATTERN.test(value)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
