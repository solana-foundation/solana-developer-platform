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
 * Google External Application Load Balancers append the verified client and
 * load-balancer addresses to any caller-supplied X-Forwarded-For prefix. Cloud
 * Run injects K_SERVICE itself, so in that environment the next-to-last IP is
 * the verified client and untrusted prefixes must be ignored. Self-hosted
 * deployments retain the conventional first-IP behavior and must configure
 * their ingress proxy to replace untrusted X-Forwarded-For values.
 */
export function resolveClientIp(
  headers: Pick<Headers, "get">,
  env: Pick<Env, "K_SERVICE">
): string | null {
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
