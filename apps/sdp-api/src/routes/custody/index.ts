/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import type { Env } from "@/types/env";
import { Hono } from "hono";
import {
  createWallet,
  getConfig,
  getPublicKey,
  initializeSigning,
  listWallets,
  setDefaultWallet,
  switchSigning,
} from "./handlers";

const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));

// Initialize signing (requires admin)
wallets.post("/initialize", requirePermissions("custody:admin"), initializeSigning);
wallets.post("/switch", requirePermissions("custody:admin"), switchSigning);
wallets.post("/", requirePermissions("custody:admin"), createWallet);
wallets.post("/default-wallet", requirePermissions("custody:admin"), setDefaultWallet);

// Read configuration and wallets
wallets.get("/config", requirePermissions("wallets:read"), getConfig);
wallets.get("/", requirePermissions("wallets:read"), listWallets);
wallets.get("/public-key", requirePermissions("wallets:read"), getPublicKey);

export default wallets;
