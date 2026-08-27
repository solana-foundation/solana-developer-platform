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
  getRingsWalletIdentity,
  listRingsOperations,
  listRingsWallets,
  listRingsZones,
  prepareRingsOperation,
  retryRingsOperation,
  syncRingsWallet,
} from "./handlers";

const heliusRings = new Hono<{ Bindings: Env }>();

/**
 * Router-wide gate: 403 unless the feature flag is on. The devnet-only guard in
 * HeliusRingsService is the second lock.
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
// A sync reads Photon but advances the wallet's recorded observation point, so
// it carries write.
heliusRings.post("/wallets/:walletId/sync", requirePermissions("payments:write"), syncRingsWallet);
// Records nothing, so unlike /sync it does not earn write.
heliusRings.get(
  "/wallets/:walletId/identity",
  requirePermissions("payments:read"),
  getRingsWalletIdentity
);
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
