import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createRingsWallet,
  createRingsZone,
  executeRingsOperation,
  getRingsHealth,
  getRingsOperation,
  getRingsWallet,
  listRingsOperations,
  listRingsWallets,
  listRingsZones,
  prepareRingsOperation,
  retryRingsOperation,
} from "./handlers";

const heliusRings = new Hono<{ Bindings: Env }>();

/**
 * Router-wide gate: 403 unless the feature flag is on. The flag stays off in
 * every deployed environment until Track B lands the live gateway; the
 * devnet-only guard inside HeliusRingsService is the second lock.
 */
async function requireHeliusRingsFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isHeliusRingsEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Helius Rings is not enabled for this environment.");
  }
  await next();
}

heliusRings.use("*", requireHeliusRingsFeature);
heliusRings.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
heliusRings.use("*", projectContextMiddleware());

heliusRings.get("/health", requirePermissions("payments:read"), getRingsHealth);

heliusRings.get("/wallets", requirePermissions("payments:read"), listRingsWallets);
heliusRings.post("/wallets", requirePermissions("payments:write"), createRingsWallet);
heliusRings.get("/wallets/:walletId", requirePermissions("payments:read"), getRingsWallet);
heliusRings.get("/wallets/:walletId/zones", requirePermissions("payments:read"), listRingsZones);
heliusRings.post("/wallets/:walletId/zones", requirePermissions("payments:write"), createRingsZone);

heliusRings.get("/operations", requirePermissions("payments:read"), listRingsOperations);
heliusRings.post("/operations", requirePermissions("payments:write"), prepareRingsOperation);
heliusRings.get("/operations/:operationId", requirePermissions("payments:read"), getRingsOperation);
heliusRings.post(
  "/operations/:operationId/execute",
  requirePermissions("payments:write"),
  executeRingsOperation
);
heliusRings.post(
  "/operations/:operationId/retry",
  requirePermissions("payments:write"),
  retryRingsOperation
);

export default heliusRings;
