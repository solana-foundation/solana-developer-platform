/**
 * The transport seam every Private Channels probe is built on.
 *
 * Gateway and auth URLs are project input, so a probe that called `fetch`
 * itself would be an SSRF primitive: whatever the caller writes, SDP dials.
 * None of the probes in this package own a transport for that reason. They are
 * handed a `ProbeTransport`, and the API supplies one that puts the
 * destination through the shared egress guard first
 * (`apps/sdp-api/src/services/private-channels/egress.ts`).
 *
 * The contract is deliberately narrower than `fetch`. A probe cannot follow a
 * redirect, stream an unbounded body, or read a header it was not given,
 * because the shape it receives back carries none of those. What crosses the
 * seam is a status, a reachability bit, and text the transport has already
 * truncated.
 */

export interface ProbeRequest {
  /** Absolute URL. The transport re-checks it; assembling it here proves nothing. */
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Transport-enforced deadline for the whole request. */
  timeoutMs: number;
}

export interface ProbeResponse {
  status: number;
  /** 2xx. A redirect is not followed, so a 3xx arrives here as `false`. */
  ok: boolean;
  /** Response text, already truncated to the transport's byte cap. */
  text: string;
}

export type ProbeTransport = (request: ProbeRequest) => Promise<ProbeResponse>;

/**
 * Upstream-derived strings are echoed back to the dashboard, so they are capped
 * before they leave the probe. A gateway that answers a health check with a
 * megabyte of prose gets a sentence of it repeated, not the megabyte.
 */
export const MAX_PROBE_DETAIL_CHARS = 200;

export function truncateProbeDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_PROBE_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_PROBE_DETAIL_CHARS)}…`
    : trimmed;
}
