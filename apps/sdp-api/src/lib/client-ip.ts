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
