import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createRingsProjectRing,
  createRingsWallet,
  createRingsZone,
  executeRingsOperation,
  getRingsHealth,
  getRingsOperation,
  getRingsWallet,
  getRingsWalletIdentity,
  listRingsOperations,
  listRingsProjectRings,
  listRingsWallets,
  listRingsZones,
  prepareRingsOperation,
  recheckRingsOperation,
  retryRingsOperation,
  syncRingsWallet,
  voidRingsOperation,
} from "./handlers";

const heliusRings = new Hono<{ Bindings: Env }>();

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

heliusRings.get("/rings", requirePermissions("payments:read"), listRingsProjectRings);
// Recording a ring runs bring-up (signed transactions through custody), so it
// carries write.
heliusRings.post("/rings", requirePermissions("payments:write"), createRingsProjectRing);

heliusRings.get("/wallets", requirePermissions("payments:read"), listRingsWallets);
heliusRings.post("/wallets", requirePermissions("payments:write"), createRingsWallet);
heliusRings.get("/wallets/:walletId", requirePermissions("payments:read"), getRingsWallet);
heliusRings.post("/wallets/:walletId/sync", requirePermissions("payments:write"), syncRingsWallet);
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
// Write, not read: a recheck only observes the indexer, but a hit completes the
// operation and advances the wallet's indexed slot.
heliusRings.post(
  "/operations/:operationId/recheck",
  requirePermissions("payments:write"),
  recheckRingsOperation
);
heliusRings.post(
  "/operations/:operationId/void",
  requirePermissions("payments:write"),
  voidRingsOperation
);

export default heliusRings;
