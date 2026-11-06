import { getSdpDocsOrigin } from "@sdp/types/site";
import { cors } from "hono/cors";
import type { Env } from "@/types/env";

const PRODUCTION_ORIGINS = [
  "https://solana.com",
  "https://www.solana.com",
  "https://developer.solana.com",
];

const DEVELOPMENT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
];

const DEVELOPMENT_ORIGIN_PATTERNS = ["https://*.vercel.app"];

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, "[^.]*")}$`);
}

export function createOriginMatcher(
  exactOrigins: string[],
  wildcardPatterns: string[]
): (origin: string) => boolean {
  const exact = new Set(exactOrigins);
  const patterns = wildcardPatterns.map(wildcardToRegExp);
  return (origin) => exact.has(origin) || patterns.some((pattern) => pattern.test(origin));
}

/**
 * The deployment's extra allowed origins (`CORS_EXTRA_ORIGIN`), for a
 * deployment whose docs site is not the canonical one: none when unset, else
 * exactly one https origin. Anything else throws, so the entrypoint fails at
 * boot instead of serving without the origin it was given.
 *
 * @param value - The configured value.
 * @returns The origins to add.
 */
export function extraAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const origin = value.trim();
  if (
    !URL.canParse(origin) ||
    new URL(origin).protocol !== "https:" ||
    new URL(origin).origin !== origin
  ) {
    throw new Error(`Invalid CORS_EXTRA_ORIGIN: "${value}". Expected one https origin.`);
  }
  return [origin];
}

export function corsMiddleware(env: Env["ENVIRONMENT"], extraOrigin?: string) {
  const isProduction = env === "production";
  const exactOrigins = [
    ...(isProduction ? [...PRODUCTION_ORIGINS, getSdpDocsOrigin()] : DEVELOPMENT_ORIGINS),
    ...extraAllowedOrigins(extraOrigin),
  ];
  const wildcardPatterns = isProduction ? [] : DEVELOPMENT_ORIGIN_PATTERNS;
  const isAllowedOrigin = createOriginMatcher(exactOrigins, wildcardPatterns);

  return cors({
    origin: (origin) => {
      // Never reflect an unlisted origin: this app mounts the earn money
      // routes, and non-production deployments hold real devnet funds (PRO-1865).
      if (!origin) return null;
      return isAllowedOrigin(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Accept legacy callers' IDs without breaking preflight. The response ID
    // is always server-generated; integrators correlate using that returned ID.
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID", "Idempotency-Key"],
    exposeHeaders: [
      "X-Request-ID",
      "Idempotency-Key",
      "Idempotent-Replayed",
      "Retry-After",
      "Server-Timing",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86400,
  });
}
