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
 * Forwarding headers are trusted only after the deployment explicitly opts in
 * with TRUST_PROXY_HEADERS=true, because K_SERVICE marks the Cloud Run runtime
 * but says nothing about the network path a request took: a service reachable
 * through its run.app URL receives an entirely caller-controlled
 * X-Forwarded-For chain, and the value this function returns is what API-key
 * and organization IP allowlists evaluate. A Cloud Run deployment sets the
 * opt-in only after restricting ingress to the external load balancer, whose
 * front end appends the verified client and load-balancer addresses to any
 * caller-supplied prefix — so in that environment the next-to-last IP is the
 * verified client and untrusted prefixes must be ignored. A self-hosted
 * operator sets it only after configuring its ingress to replace untrusted
 * X-Forwarded-For values.
 */
export function resolveClientIp(
  headers: Pick<Headers, "get">,
  env: Pick<Env, "K_SERVICE" | "TRUST_PROXY_HEADERS">
): string | null {
  if (env.TRUST_PROXY_HEADERS !== "true") {
    return null;
  }

  const forwarded = parseForwardedFor(headers.get("x-forwarded-for") ?? undefined);
  if (forwarded.length === 0) {
    return null;
  }

  if (env.K_SERVICE) {
    // The Google load balancer appends [verified client, load balancer]. A
    // shorter chain has no verified client address, so fail closed instead of
    // accepting a caller-controlled single entry.
    return forwarded.length >= 2 ? (forwarded.at(-2) ?? null) : null;
  }

  return forwarded[0] ?? null;
}

export function getClientIp(c: Context<{ Bindings: Env }>): string | null {
  return resolveClientIp({ get: (name) => c.req.header(name) ?? null }, c.env ?? {});
}
