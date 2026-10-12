/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  createWallet,
  deleteWallet,
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
  initializeSigning
);
wallets.post(
  "/",
  requirePermissions("custody:admin"),
  validateBody(createWalletSchema),
  createWallet
);
wallets.delete(
  "/",
  requirePermissions("custody:admin"),
  validateBody(deleteWalletSchema),
  deleteWallet
);
wallets.patch(
  "/:walletId",
  requirePermissions("custody:admin"),
  validateBody(updateWalletSchema),
  updateWallet
);
wallets.post(
  "/signer-check",
  requirePermissions("wallets:write"),
  validateBody(signerCheckSchema),
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
