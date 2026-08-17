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
  approveApprovalRequest,
  cancelApprovalRequest,
  createWallet,
  deleteWallet,
  getApprovalRequest,
  getConfig,
  getConfigs,
  getPublicKey,
  getSwitchProviderOptions,
  getWalletAggregate,
  getWalletById,
  initializeSigning,
  listApprovalRequests,
  listWallets,
  rejectApprovalRequest,
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
wallets.get("/approval-requests", requirePermissions("wallets:read"), listApprovalRequests);
wallets.get(
  "/approval-requests/:approvalRequestId",
  requirePermissions("wallets:read"),
  getApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/approve",
  requirePermissions("wallets:write"),
  approveApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/reject",
  requirePermissions("wallets:write"),
  rejectApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/cancel",
  requirePermissions("wallets:write"),
  cancelApprovalRequest
);
wallets.get("/:walletId", requirePermissions("wallets:read"), getWalletById);

export default wallets;
