import { getSdpDocsOrigin } from "@sdp/types";
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

export function corsMiddleware(env: Env["ENVIRONMENT"]) {
  const isProduction = env === "production";
  const exactOrigins = isProduction
    ? [...PRODUCTION_ORIGINS, getSdpDocsOrigin()]
    : DEVELOPMENT_ORIGINS;
  const wildcardPatterns = isProduction ? [] : DEVELOPMENT_ORIGIN_PATTERNS;
  const isAllowedOrigin = createOriginMatcher(exactOrigins, wildcardPatterns);

  return cors({
    origin: (origin) => {
      if (!origin) return null;
      if (isAllowedOrigin(origin)) return origin;
      if (!isProduction) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID", "Idempotency-Key"],
    exposeHeaders: [
      "X-Request-ID",
      "Idempotency-Key",
      "Server-Timing",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86400,
    credentials: true,
  });
}
