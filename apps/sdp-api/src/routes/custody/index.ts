/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { replayFromRecord } from "@/middleware/movement-steps";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  authorizeCreateWallet,
  authorizeDeleteWallet,
  authorizeInitializeSigning,
  authorizeSignerCheck,
  authorizeUpdateWallet,
} from "./access";
import {
  createWallet,
  deleteWallet,
  findCustodyWalletCreateReplay,
  getConfigs,
  getPublicKey,
  getWalletAggregate,
  getWalletById,
  initializeSigning,
  listWallets,
  signerCheck,
  updateWallet,
} from "./handlers";
import {
  createWalletSchema,
  deleteWalletSchema,
  initializeSigningSchema,
  signerCheckSchema,
  updateWalletSchema,
} from "./schemas";

const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware());
wallets.use("*", projectContextMiddleware());

// Initialize signing (requires admin)
wallets.post(
  "/initialize",
  requirePermissions("custody:admin"),
  validateBody(initializeSigningSchema),
  authorize(authorizeInitializeSigning),
  idempotent({ key: "accepted", serverErrors: "store" }),
  initializeSigning
);
wallets.post(
  "/",
  requirePermissions("custody:admin"),
  validateBody(createWalletSchema),
  authorize(authorizeCreateWallet),
  // A retry the key could not answer (a crash, a takeover) finds the wallet row.
  idempotent({ key: "accepted", serverErrors: "store", recovery: "record" }),
  replayFromRecord(findCustodyWalletCreateReplay),
  createWallet
);
wallets.delete(
  "/",
  requirePermissions("custody:admin"),
  validateBody(deleteWalletSchema),
  authorize(authorizeDeleteWallet),
  idempotent({ key: "accepted", serverErrors: "store" }),
  deleteWallet
);
wallets.patch(
  "/:walletId",
  requirePermissions("custody:admin"),
  validateBody(updateWalletSchema),
  authorize(authorizeUpdateWallet),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateWallet
);
wallets.post(
  "/signer-check",
  requirePermissions("wallets:write"),
  validateBody(signerCheckSchema),
  authorize(authorizeSignerCheck),
  // Before the quota, so a replayed check is never counted again.
  idempotent({ key: "accepted", serverErrors: "store" }),
  meteredQuota({ name: "signer-check", actorMax: 2, orgMax: 10 }),
  signerCheck
);

// Read configuration and wallets
wallets.get("/configs", requirePermissions("wallets:read"), getConfigs);
wallets.get("/", requirePermissions("wallets:read"), listWallets);
wallets.get("/aggregate", requirePermissions("wallets:read"), getWalletAggregate);
wallets.get("/public-key", requirePermissions("wallets:read"), getPublicKey);
wallets.get("/:walletId", requirePermissions("wallets:read"), getWalletById);

export default wallets;
