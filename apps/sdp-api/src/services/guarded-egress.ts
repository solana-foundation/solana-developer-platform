/**
 * Outbound HTTPS for endpoints a tenant supplies.
 *
 * `assertReachableTenantEndpoint` rejects a URL whose host is written as a
 * private literal, which is only half the boundary: a name the tenant controls
 * can resolve to a loopback, private, link-local or metadata address and the
 * literal check never sees it. The guard here runs at connect time and hands
 * the socket only addresses that passed, so a record that changes between the
 * check and the connection cannot widen it either.
 *
 * It applies to tenant endpoints alone. Platform provider endpoints come from
 * deployment config and are legitimately private in local development and in
 * the Surfpool integration suites, so those keep the ordinary fetch.
 *
 * Private Channels probes come through here too, via
 * `services/private-channels/egress.ts`, which pairs this transport with an
 * exact origin allowlist because a project supplies those URLs directly.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isBlockedAddress } from "@sdp/rpc/blocked-address";

export { isBlockedAddress };

export class EgressBlockedError extends Error {
  constructor(host: string) {
    super(`The RPC endpoint host ${host} resolves to an address SDP will not connect to`);
    this.name = "EgressBlockedError";
  }
}

/** Statuses the Response constructor refuses a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A `dns.lookup` replacement that drops every blocked address before the
 * socket sees it. Node calls this while connecting, so the addresses it
 * returns are the ones actually dialled.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...(options as object), all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }

    const resolved = Array.isArray(addresses) ? addresses : [addresses];
    const allowed = resolved.filter((entry) => !isBlockedAddress(entry.address));
    if (allowed.length === 0) {
      callback(new EgressBlockedError(hostname), "", 0);
      return;
    }

    if (typeof options === "object" && options?.all) {
      (callback as (error: null, addresses: typeof allowed) => void)(null, allowed);
      return;
    }

    const [first] = allowed;
    callback(null, first?.address ?? "", first?.family ?? 0);
  });
};

export interface GuardedFetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Propagates the caller's transport timeout/cancellation to the socket. */
  signal?: AbortSignal;
  /**
   * How many redirects to follow. Zero is the probe's existing `redirect:
   * "manual"`. The relay follows a few, because a provider answering on a
   * canonical or regional host is ordinary, and every hop is resolved through
   * the guard again rather than trusted for having come from an allowed one.
   */
  maxRedirects?: number;
  /**
   * Stop buffering the response body past this many bytes. Callers that relay
   * an upstream payload leave it off; a probe that only reads a status and a
   * short reason sets it, so a hostile endpoint cannot answer a health check
   * with a body large enough to matter.
   */
  maxResponseBytes?: number;
  /**
   * Set only for a destination that matched an exact operator-approved
   * allowlist entry which is itself plaintext or a private literal — the public
   * Private Channels sandbox answers on `http://`, and a developer's gateway is
   * on loopback. It permits `http:` and dials without the address check, since
   * the operator named that exact origin in deployment config. It must never be
   * set from anything a request can influence: for tenant input, the allowlist
   * is what decides, and this flag then only repeats a decision already made.
   */
  approvedInsecureDestination?: boolean;
  /**
   * The operator approved this origin on plaintext http, but its host is a
   * NAME: the transport is relaxed while the connect-time address check stays,
   * so the name still resolves through `guardedLookup`. Same trust rule as
   * `approvedInsecureDestination`: never set from anything a request can
   * influence.
   */
  approvedPlaintextDestination?: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface RedirectStep {
  url: string;
  method: string;
  body: string;
}

const CROSS_ORIGIN_REDIRECT_HEADERS = new Set(["accept", "content-type"]);

/**
 * Tenant RPC headers may use provider-specific names, so there is no complete
 * denylist for credentials. Preserve them only within the same origin. A
 * cross-origin redirect receives the protocol headers SDP owns, never the
 * tenant-supplied authentication material.
 */
export function headersForRedirect(
  from: string,
  to: string,
  headers: Record<string, string>
): Record<string, string> {
  if (new URL(from).origin === new URL(to).origin) {
    return headers;
  }

  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())
    )
  );
}

/**
 * The next request a redirect asks for, or null when it is not a redirect we
 * follow. Method handling matches what `fetch` did before the guard existed:
 * 307 and 308 repeat the request, 301, 302 and 303 downgrade to GET and drop
 * the body. Split out so the rules can be read and tested without a socket.
 */
export function nextRedirectStep(
  status: number,
  location: string | null,
  from: string,
  init: { method: string; body: string }
): RedirectStep | null {
  if (!REDIRECT_STATUSES.has(status) || !location) {
    return null;
  }

  const url = new URL(location, from).toString();
  if (status === 307 || status === 308) {
    return { url, method: init.method, body: init.body };
  }
  return { url, method: "GET", body: "" };
}

/**
 * Same shape as a `fetch` call the caller would otherwise make. Every hop,
 * including a redirected one, resolves through `guardedLookup`, so a redirect
 * cannot walk the request somewhere the first check refused.
 *
 * `approvedInsecureDestination` names the origin the caller approved, which the
 * upstream's `Location` header is not, so it does not travel to the next hop:
 * a redirect off an approved plaintext origin is a fresh destination and faces
 * the full check.
 */
export async function guardedFetch(url: string, init: GuardedFetchInit): Promise<Response> {
  const target = new URL(url);
  const plaintextApproved =
    target.protocol === "http:" &&
    (init.approvedPlaintextDestination || init.approvedInsecureDestination);
  if (target.protocol !== "https:" && !plaintextApproved) {
    throw new EgressBlockedError(target.hostname);
  }

  const response = await guardedRequest(target, init);
  const step = nextRedirectStep(response.status, response.headers.get("location"), url, init);
  if (!step || !init.maxRedirects) {
    return response;
  }

  return guardedFetch(step.url, {
    ...init,
    headers: headersForRedirect(url, step.url, init.headers),
    method: step.method,
    body: step.body,
    maxRedirects: init.maxRedirects - 1,
    approvedInsecureDestination: false,
    approvedPlaintextDestination: false,
  });
}

async function guardedRequest(target: URL, init: GuardedFetchInit): Promise<Response> {
  // An operator-approved destination is reached without the address check —
  // that is what approving a plaintext or loopback origin means — but the
  // request still refuses redirects and still bounds what it reads back.
  const request = target.protocol === "http:" ? httpRequest : httpsRequest;
  const lookup = init.approvedInsecureDestination ? undefined : guardedLookup;

  // A host written as an address never reaches the lookup hook — Node dials a
  // literal directly — so it is classified here, before the socket exists.
  const literalHost = target.hostname.replace(/^\[|\]$/g, "");
  if (!init.approvedInsecureDestination && isIP(literalHost) && isBlockedAddress(literalHost)) {
    throw new EgressBlockedError(target.hostname);
  }

  return new Promise<Response>((resolve, reject) => {
    const req = request(
      target,
      { method: init.method, headers: init.headers, lookup, signal: init.signal },
      (res) => {
        const chunks: Buffer[] = [];
        let buffered = 0;
        res.on("data", (chunk: Buffer) => {
          // Past the cap the stream is drained rather than destroyed: an
          // aborted read races the `end` this promise settles on, and the
          // caller's signal already bounds how long draining can take.
          const room =
            init.maxResponseBytes === undefined
              ? chunk.length
              : Math.max(0, init.maxResponseBytes - buffered);
          if (room === 0) return;
          chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
          buffered += Math.min(room, chunk.length);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) headers.set(key, value.join(", "));
          }
          const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks).toString();
          resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
        });
      }
    );

    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * `guardedFetch` behind the WHATWG fetch signature, for libraries that accept
 * a `fetch` implementation but know nothing about the egress guard.
 *
 * Strict on purpose: a `Request` input or a non-string body is refused rather
 * than partially honored, because silently dropping a body or an option would
 * send a request the caller did not write. Every JSON-RPC client this serves
 * sends string bodies.
 */
export function createGuardedFetch(options?: {
  maxRedirects?: number;
  maxResponseBytes?: number;
}): typeof globalThis.fetch {
  return async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("guarded fetch takes a URL, not a Request");
    }
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new TypeError("guarded fetch only sends string bodies");
    }

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    return guardedFetch(input.toString(), {
      method: init?.method ?? "GET",
      headers,
      body: init?.body ?? "",
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(options?.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
      ...(options?.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    });
  };
}
