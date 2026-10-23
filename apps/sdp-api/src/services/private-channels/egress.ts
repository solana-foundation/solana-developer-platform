/**
 * Where a Private Channels probe is allowed to go.
 *
 * A project types its own gateway and auth URLs into the connect form and the
 * API then fetches them, which is the shape that turns `GET /health`,
 * `POST /probe`, Connect and the instance overview into SSRF primitives. Two
 * independent gates close that:
 *
 *   Allowlist. A destination has to match an operator-approved origin exactly —
 *   scheme, host and port — after `URL` has canonicalised the host. That
 *   canonicalisation is why the encoded spellings are covered rather than
 *   enumerated: `http://2130706433`, `http://0x7f.0.0.1`, `http://127.1` and
 *   `http://%31%32%37%2e%30%2e%30%2e%31` all parse to origin
 *   `http://127.0.0.1`, and none of them is on anyone's list. Matching is exact,
 *   so `https://gw.example.com` authorises neither `https://evil.gw.example.com`
 *   nor `https://gw.example.com.evil.test`, and a URL carrying credentials
 *   (`https://gw.example.com@evil.test`) has origin `https://evil.test` and is
 *   refused on both counts. The list is deployment configuration
 *   (`PRIVATE_CHANNEL_EGRESS_ALLOWLIST`) plus the built-in public sandbox —
 *   never anything a request can influence.
 *
 *   Transport. The request then goes through the shared `guardedFetch`, which
 *   does not follow redirects and resolves the host through `guardedLookup`, so
 *   an allowlisted name that points at loopback, a private range or the
 *   metadata address is dropped while connecting rather than while validating.
 *   A record that flips between the two has nothing left to win.
 *
 * Tenant-supplied destinations are therefore https, public and exactly listed.
 * An allowlist entry that is itself plaintext or a private literal is honoured
 * as written — the public sandbox gateway answers on `http://`, and a developer
 * running SPC locally points at loopback — because writing an origin into
 * deployment config is the operator approving that one destination. Nothing a
 * project sends can add an entry or change how one is classified.
 */
import { SANDBOX_DEFAULTS } from "@sdp/private-channels/constants";
import type { ProbeRequest, ProbeResponse, ProbeTransport } from "@sdp/private-channels/transport";
import { isBlockedAddress } from "@sdp/rpc/blocked-address";
import { RpcHttpStatusError } from "@sdp/rpc/errors";
import type { RpcTransport } from "@solana/kit";
import { badRequest } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import { guardedFetch } from "@/services/guarded-egress";
import type { Env } from "@/types/env";

/**
 * A probe reads a status and a short reason. 64 KiB is far more than either
 * needs and still small enough that a hostile gateway answering a health check
 * cannot make the response the interesting part.
 */
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;

/** Origins SDP ships as approved: the project's own public sandbox instance. */
const BUILT_IN_ORIGINS: readonly string[] = [SANDBOX_DEFAULTS.gatewayUrl, SANDBOX_DEFAULTS.authUrl];

export interface ApprovedOrigin {
  /** Canonical `scheme://host[:port]`. */
  origin: string;
  /**
   * The operator's own entry is plaintext. Carried on the entry rather than
   * derived from the candidate, so the relaxation belongs to the configured
   * origin and a matching request simply inherits it.
   */
  plaintext: boolean;
  /**
   * The operator's own entry is a private literal, so no resolution step
   * remains to guard. A plaintext NAME does not qualify: it still resolves
   * through `guardedLookup` while dialling.
   */
  insecure: boolean;
}

export type PrivateChannelEgressAllowlist = ReadonlyMap<string, ApprovedOrigin>;

/**
 * A trailing dot names the same host but serialises differently, so it is
 * removed on both sides. Otherwise `https://gw.example.com./` would miss an
 * entry for the host it actually reaches.
 */
function stripTrailingDot(hostname: string): string {
  return hostname.length > 1 && hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * The URL in the one spelling everything downstream compares against, or null
 * when it is not a probe destination at all: unparseable, a scheme other than
 * http(s), or carrying credentials.
 */
function canonicalize(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // `https://user:pass@host` is both a credential leak to the upstream and a
  // classic way to make a URL read as one host while resolving another.
  if (url.username || url.password) return null;

  const hostname = stripTrailingDot(url.hostname);
  if (!hostname) return null;
  url.hostname = hostname;
  return url;
}

/** Whether the host is written as an address rather than a name. */
function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export function buildPrivateChannelEgressAllowlist(
  entries: Iterable<string>
): PrivateChannelEgressAllowlist {
  const allowlist = new Map<string, ApprovedOrigin>();
  for (const entry of entries) {
    const url = canonicalize(entry);
    // An entry SDP cannot parse approves nothing. Dropping it keeps a typo from
    // widening the boundary, at the cost of a destination that stops working.
    if (!url) continue;
    const bareHost = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    allowlist.set(url.origin, {
      origin: url.origin,
      plaintext: url.protocol === "http:",
      insecure: isIpLiteral(url.hostname) && isBlockedAddress(bareHost),
    });
  }
  return allowlist;
}

function parseAllowlistSetting(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Keyed by the setting itself: parsing is pure, so two deployments reading the
// same list share one map and a test that changes the env is not stale.
const allowlistCache = new Map<string, PrivateChannelEgressAllowlist>();

export function resolvePrivateChannelEgressAllowlist(
  env: Pick<Env, "PRIVATE_CHANNEL_EGRESS_ALLOWLIST">
): PrivateChannelEgressAllowlist {
  const setting = env.PRIVATE_CHANNEL_EGRESS_ALLOWLIST ?? "";
  const cached = allowlistCache.get(setting);
  if (cached) return cached;

  const allowlist = buildPrivateChannelEgressAllowlist([
    ...BUILT_IN_ORIGINS,
    ...parseAllowlistSetting(setting),
  ]);
  allowlistCache.set(setting, allowlist);
  return allowlist;
}

export type DestinationCheck =
  | { ok: true; url: URL; approved: ApprovedOrigin }
  | { ok: false; error: string };

/**
 * Decide one destination against the allowlist. Returns rather than throws so
 * the probes can report an unreachable endpoint the same way they report a
 * refused connection — a caller learns its URL is not approved, and nothing
 * about what else this deployment can reach.
 */
export function checkPrivateChannelDestination(
  raw: string,
  allowlist: PrivateChannelEgressAllowlist,
  field: string
): DestinationCheck {
  const url = canonicalize(raw);
  if (!url) {
    return {
      ok: false,
      error: `${field} must be an http(s) URL with no embedded credentials.`,
    };
  }

  const approved = allowlist.get(url.origin);
  if (!approved) {
    return {
      ok: false,
      error: `${field} (${url.origin}) is not on this deployment's approved Private Channels egress allowlist.`,
    };
  }

  return { ok: true, url, approved };
}

/**
 * Reject a connect request whose URLs are not approved, as a field error the
 * operator can act on. The probes refuse the same destinations on their own —
 * this only turns a confusing "unreachable" into "that origin is not approved
 * here" on the one path where a human is configuring an instance.
 */
export function assertApprovedPrivateChannelDestinations(
  env: Env,
  input: { gatewayUrl: string; authUrl: string }
): void {
  const allowlist = resolvePrivateChannelEgressAllowlist(env);
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, raw] of Object.entries(input)) {
    const checked = checkPrivateChannelDestination(raw, allowlist, field);
    if (!checked.ok) fieldErrors[field] = [checked.error];
  }

  if (Object.keys(fieldErrors).length > 0) {
    getLogger().warn(
      { fieldErrors },
      "private-channel destination refused by the egress allowlist"
    );
    throw badRequest("Invalid connection details", { fieldErrors });
  }
}

/**
 * The transport every Private Channels probe is handed. It re-checks each URL
 * rather than trusting the caller assembled it from a checked base, so a path
 * built anywhere in the probe layer still cannot leave an approved origin.
 */
export function createPrivateChannelProbeTransport(env: Env): ProbeTransport {
  const allowlist = resolvePrivateChannelEgressAllowlist(env);

  return async (request: ProbeRequest): Promise<ProbeResponse> => {
    const checked = checkPrivateChannelDestination(request.url, allowlist, "Probe destination");
    if (!checked.ok) throw new Error(checked.error);

    const response = await guardedFetch(checked.url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body ?? "",
      signal: AbortSignal.timeout(request.timeoutMs),
      maxResponseBytes: MAX_PROBE_RESPONSE_BYTES,
      approvedInsecureDestination: checked.approved.insecure,
      approvedPlaintextDestination: checked.approved.plaintext,
    });

    return { status: response.status, ok: response.ok, text: await response.text() };
  };
}

/**
 * How long a runtime leg (gateway JSON-RPC or auth REST) gets to answer. Joins
 * the caller's own signal below.
 */
const MAX_SPC_RUNTIME_TIMEOUT_MS = 30_000;

/**
 * Upper bound on what is buffered back from a gateway JSON-RPC answer. Sized
 * for the largest ordinary answers (`getSignaturesForAddress`, `getTransaction`)
 * with room to spare; a hostile gateway cannot stream unbounded bytes.
 */
const MAX_GATEWAY_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Upper bound on an auth REST answer (a challenge, a JWT, a verified-wallet
 * echo) — far smaller than a gateway answer needs.
 */
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

/**
 * The time bound joins the caller's signal rather than yielding to it: the Kit
 * transport always supplies one, and a caller's cancellation must not disable
 * the ceiling.
 */
function boundedRuntimeSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(MAX_SPC_RUNTIME_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * A Solana Kit transport for one instance's gateway URL — the JSON-RPC legs the
 * probes do not cover (`withGatewayRpc`: blockhash, broadcast, balances, tx
 * lookups). The connect-time allowlist check that gated the probes applies
 * here on every dial too, because a stored row's URL is re-read at runtime
 * long after connect: routing the runtime legs through the same guard keeps a
 * rebinding DNS name or a tampered row from pointing SDP's process at an
 * internal address while it carries bearer tokens and channel instructions.
 * Like the probe it does not follow redirects: a `Location` names an origin
 * nothing approved, so a 3xx surfaces as its own non-2xx error rather than
 * walking the request off the allowlisted destination.
 */
export function createPrivateChannelGatewayTransport(
  env: Env,
  gatewayUrl: string,
  headers: Record<string, string> = {}
): RpcTransport {
  const allowlist = resolvePrivateChannelEgressAllowlist(env);

  return async function gatewayTransport<TResponse>({
    payload,
    signal,
  }: Parameters<RpcTransport>[0]): Promise<TResponse> {
    const checked = checkPrivateChannelDestination(gatewayUrl, allowlist, "Gateway URL");
    if (!checked.ok) throw new Error(checked.error);

    const upstream = await guardedFetch(checked.url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: boundedRuntimeSignal(signal),
      maxResponseBytes: MAX_GATEWAY_RESPONSE_BYTES,
      rejectOversizeResponse: true,
      approvedInsecureDestination: checked.approved.insecure,
      approvedPlaintextDestination: checked.approved.plaintext,
    });

    if (!upstream.ok) {
      throw new RpcHttpStatusError(
        upstream.status,
        `RPC request failed with HTTP ${upstream.status}`
      );
    }

    // SAFETY: the body is whatever the approved gateway answered a JSON-RPC
    // call with; kit's RPC methods decode and validate the fields they read,
    // and a non-JSON answer throws at the parse right here.
    return (await upstream.json()) as TResponse;
  };
}

/**
 * A WHATWG `fetch` for the SPC auth REST legs (`createAuthClient`'s
 * `fetchImpl`), guarded the same way as the probe transport: every call is
 * re-checked against the deployment allowlist and resolved through the egress
 * guard, so an allowlisted name that starts answering from a private address
 * is dropped while connecting. Like the probe it does not follow redirects —
 * a `Location` names an origin nothing approved — and like `createGuardedFetch`
 * it refuses a body it cannot send rather than sending a different one. Auth
 * answers are small; anything past the cap is refused as corruption.
 */
export function createPrivateChannelAuthFetch(
  env: Pick<Env, "PRIVATE_CHANNEL_EGRESS_ALLOWLIST">
): typeof fetch {
  const allowlist = resolvePrivateChannelEgressAllowlist(env);

  return async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("guarded auth fetch takes a URL, not a Request");
    }
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new TypeError("guarded auth fetch only sends string bodies");
    }

    const checked = checkPrivateChannelDestination(input.toString(), allowlist, "Auth URL");
    if (!checked.ok) throw new Error(checked.error);

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    return guardedFetch(checked.url.toString(), {
      method: init?.method ?? "GET",
      headers,
      body: init?.body ?? "",
      signal: init?.signal ?? undefined,
      maxResponseBytes: MAX_AUTH_RESPONSE_BYTES,
      rejectOversizeResponse: true,
      approvedInsecureDestination: checked.approved.insecure,
      approvedPlaintextDestination: checked.approved.plaintext,
    });
  };
}
