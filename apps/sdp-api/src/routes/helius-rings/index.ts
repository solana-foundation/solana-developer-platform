import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isHeliusRingsEnabled } from "@/lib/feature-flags";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import type { Env } from "@/types/env";
import {
  createRingsProjectRing,
  createRingsWallet,
  createRingsZone,
  executeRingsOperation,
  getRingsHealth,
  getRingsOperation,
  getRingsSetup,
  getRingsWallet,
  getRingsWalletIdentity,
  listRingsOperations,
  listRingsProjectRings,
  listRingsWallets,
  listRingsZones,
  prepareRingsOperation,
  recheckRingsOperation,
  rekeyRingsWallet,
  retryRingsOperation,
  syncRingsWallet,
  voidRingsOperation,
} from "./handlers";

export const heliusRings = new Hono<{ Bindings: Env }>();

async function requireHeliusRingsFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isHeliusRingsEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Helius Rings is not enabled for this environment.");
  }
  await next();
}

heliusRings.use("*", requireHeliusRingsFeature);
heliusRings.use("*", unifiedAuthMiddleware());
heliusRings.use("*", projectContextMiddleware());

heliusRings.get("/health", requireAction("helius_rings.read"), getRingsHealth);
heliusRings.get("/setup-status", requireAction("helius_rings.read"), getRingsSetup);

heliusRings.get("/rings", requireAction("helius_rings.read"), listRingsProjectRings);
// Recording a ring runs bring-up (signed transactions through custody), so it
// carries execute.
heliusRings.post("/rings", requireAction("helius_rings.execute"), createRingsProjectRing);

heliusRings.get("/wallets", requireAction("helius_rings.read"), listRingsWallets);
heliusRings.post("/wallets", requireAction("helius_rings.manage"), createRingsWallet);
heliusRings.get("/wallets/:walletId", requireAction("helius_rings.read"), getRingsWallet);
heliusRings.post("/wallets/:walletId/sync", requireAction("helius_rings.manage"), syncRingsWallet);
heliusRings.post(
  "/wallets/:walletId/rekey",
  requireAction("helius_rings.execute"),
  rekeyRingsWallet
);
heliusRings.get(
  "/wallets/:walletId/identity",
  requireAction("helius_rings.read"),
  getRingsWalletIdentity
);
heliusRings.get("/wallets/:walletId/zones", requireAction("helius_rings.read"), listRingsZones);
// A zone is an SDP row; nothing signs.
heliusRings.post("/wallets/:walletId/zones", requireAction("helius_rings.manage"), createRingsZone);

heliusRings.get("/operations", requireAction("helius_rings.read"), listRingsOperations);
heliusRings.post("/operations", requireAction("helius_rings.execute"), prepareRingsOperation);
heliusRings.get("/operations/:operationId", requireAction("helius_rings.read"), getRingsOperation);
heliusRings.post(
  "/operations/:operationId/execute",
  requireAction("helius_rings.execute"),
  executeRingsOperation
);
heliusRings.post(
  "/operations/:operationId/retry",
  requireAction("helius_rings.execute"),
  retryRingsOperation
);
// Write, not read: a recheck only observes the indexer, but a hit completes the
// operation and advances the wallet's indexed slot.
heliusRings.post(
  "/operations/:operationId/recheck",
  requireAction("helius_rings.manage"),
  recheckRingsOperation
);
heliusRings.post(
  "/operations/:operationId/void",
  requireAction("helius_rings.manage"),
  voidRingsOperation
);
