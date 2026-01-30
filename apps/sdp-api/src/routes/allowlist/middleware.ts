import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

// Simple admin key check middleware
// In production, use proper admin authentication
export const adminAuth = async (
  c: { env: Env; req: { header: (name: string) => string | undefined } },
  next: () => Promise<void>
) => {
  const adminKey = c.req.header("X-Admin-Key");

  // In development, allow without key
  if (c.env.ENVIRONMENT === "development") {
    await next();
    return;
  }

  // In staging/production, require admin key
  // This should be replaced with proper admin auth
  if (!adminKey) {
    throw new AppError("UNAUTHORIZED", "Admin authentication required");
  }

  await next();
};
