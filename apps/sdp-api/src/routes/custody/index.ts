/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  createWallet,
  deleteWallet,
  getConfig,
  getConfigs,
  getPublicKey,
  getSwitchProviderOptions,
  getWalletAggregate,
  getWalletById,
  initializeSigning,
  listWallets,
  setDefaultWallet,
  signerCheck,
  switchSigning,
  updateWallet,
} from "./handlers";

const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
wallets.use("*", projectContextMiddleware());

// Initialize signing (requires admin)
wallets.post("/initialize", requirePermissions("custody:admin"), initializeSigning);
wallets.post("/switch", requirePermissions("custody:admin"), switchSigning);
wallets.post("/", requirePermissions("custody:admin"), createWallet);
wallets.delete("/", requirePermissions("custody:admin"), deleteWallet);
wallets.post("/default-wallet", requirePermissions("custody:admin"), setDefaultWallet);
wallets.patch("/:walletId", requirePermissions("custody:admin"), updateWallet);
wallets.post("/signer-check", requirePermissions("wallets:write"), signerCheck);

// Read configuration and wallets
wallets.get("/config", requirePermissions("wallets:read"), getConfig);
wallets.get("/configs", requirePermissions("wallets:read"), getConfigs);
wallets.get("/", requirePermissions("wallets:read"), listWallets);
wallets.get("/aggregate", requirePermissions("wallets:read"), getWalletAggregate);
wallets.get("/public-key", requirePermissions("wallets:read"), getPublicKey);
wallets.get("/switch-options", requirePermissions("custody:admin"), getSwitchProviderOptions);
wallets.get("/:walletId", requirePermissions("wallets:read"), getWalletById);

export default wallets;
