/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { approvedWalletOperationId } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
import {
  approveApprovalRequest,
  cancelApprovalRequest,
  createWallet,
  deleteWallet,
  extractSignerCheckPolicyCandidate,
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
// Each signer check broadcasts a fee-paying memo transaction, so it carries
// the fail-closed metered quota like other paid-side-effect routes.
// Two ceilings for two different costs. This one is fail-closed on the
// attempt: reaching the gate persists an operation and an evaluation, so a
// caller probing policy still has to pay for the database work. The narrower
// fee ceiling is charged inside the handler, past the gate, so denied calls
// cannot drain the budget that exists to bound lamports.
const attemptQuota = meteredQuota({
  name: "signer-check-attempt",
  actorMax: 30,
  orgMax: 90,
});

wallets.post(
  "/signer-check",
  requirePermissions("wallets:write"),
  // An approved replay already paid for its attempt when it was first
  // submitted. Charging it again would let a transient 429 record the
  // operation as failed, and recovery only retries ones still executing, so a
  // check a human approved would never broadcast.
  async (c, next) => (approvedWalletOperationId(c) ? next() : attemptQuota(c, next)),
  policyGate({ extract: extractSignerCheckPolicyCandidate }),
  signerCheck
);

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
