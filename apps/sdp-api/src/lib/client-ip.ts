import { isIP } from "node:net";
import type { Context } from "hono";
import type { Env } from "@/types/env";

function parseForwardedFor(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => isIP(entry) !== 0);
}

/**
 * Resolve the client IP supplied by the deployment's trusted reverse proxy.
 *
 * Proxy trust is an explicit deployment assertion, never inferred from the
 * runtime. Cloud Run sets K_SERVICE on directly reachable run.app services
 * too, where every X-Forwarded-For entry except the one Cloud Run appends is
 * caller-chosen, so its presence proves nothing about ingress (APE-810).
 *
 * TRUST_PROXY_HEADERS selects the asserted topology:
 * - "gclb": ingress is restricted to a Google External Application Load
 *   Balancer, which appends the verified client and load-balancer addresses
 *   to any caller-supplied prefix; the next-to-last entry is the client.
 * - "true": a self-hosted ingress replaces caller-supplied forwarding
 *   headers, so the first entry is the client.
 * - anything else: forwarding headers are caller-controlled; resolve nothing.
 */
export function resolveClientIp(
  headers: Pick<Headers, "get">,
  env: Pick<Env, "TRUST_PROXY_HEADERS">
): string | null {
  const mode = env.TRUST_PROXY_HEADERS;
  if (mode !== "gclb" && mode !== "true") {
    return null;
  }

  const forwarded = parseForwardedFor(headers.get("x-forwarded-for") ?? undefined);
  if (forwarded.length === 0) {
    return null;
  }

  if (mode === "gclb") {
    // The Google load balancer appends [verified client, load balancer]. A
    // shorter chain has no verified client address, so fail closed instead of
    // accepting a caller-controlled single entry.
    return forwarded.length >= 2 ? (forwarded.at(-2) ?? null) : null;
  }

  return forwarded[0] ?? null;
}

/**
 * The client IP for this request: the gateway's verified `client_ip` when it
 * forwarded the request (HOO-2256), else the trusted proxy's.
 */
export function getClientIp(c: Context<{ Bindings: Env }>): string | null {
  const gatewayIdentity = c.get("gatewayIdentity");
  if (gatewayIdentity) {
    return gatewayIdentity.clientIp;
  }
  return resolveClientIp({ get: (name) => c.req.header(name) ?? null }, c.env ?? {});
}

/**
 * A client IP coarsened to its network: IPv4 to /24, IPv6 to /48 (an
 * IPv4-mapped IPv6 address as IPv4). For records about callers SDP cannot
 * identify, whose full address is personal data SDP has no need to keep
 * (SDP-022 PA-6). Anything that is not an IP address comes back null.
 */
export function truncateClientIp(ip: string | null): string | null {
  if (ip === null) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const value = mapped ?? ip;
  const version = isIP(value);
  if (version === 4) {
    return `${value.split(".").slice(0, 3).join(".")}.0`;
  }
  if (version === 6) {
    return `${expandIpv6(value).slice(0, 3).join(":")}::`;
  }
  return null;
}

/** The eight hextets of a valid IPv6 address, `::` expanded, without leading zeros. */
function expandIpv6(ip: string): string[] {
  const [head = "", tail] = ip.split("::");
  const parts = (text: string) => (text === "" ? [] : text.split(":"));
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  const zeros = Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((hextet) =>
    hextet.toLowerCase().replace(/^0+(?=.)/, "")
  );
}
