/**
 * CORS Middleware Configuration
 */

import { getSdpDocsOrigin } from "@sdp/types";
import { cors } from "hono/cors";
import type { Env } from "@/types/env";

/**
 * CORS middleware with environment-aware configuration
 */
export function corsMiddleware(env: Env["ENVIRONMENT"]) {
  const allowedOrigins =
    env === "production"
      ? [
          "https://solana.com",
          "https://www.solana.com",
          "https://developer.solana.com",
          getSdpDocsOrigin(),
        ]
      : [
          "http://localhost:3000",
          "http://localhost:3001",
          "http://localhost:5173",
          "https://*.vercel.app",
        ];

  return cors({
    origin: (origin) => {
      if (!origin) return null;

      // Check exact matches
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

      // Check wildcard patterns
      for (const pattern of allowedOrigins) {
        if (pattern.includes("*")) {
          const regex = new RegExp(`^${pattern.replace("*", ".*")}$`);
          if (regex.test(origin)) {
            return origin;
          }
        }
      }

      // In development, allow all origins
      if (env !== "production") {
        return origin;
      }

      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Request-ID", "Idempotency-Key"],
    exposeHeaders: [
      "X-Request-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ],
    maxAge: 86400, // 24 hours
    credentials: true,
  });
}
