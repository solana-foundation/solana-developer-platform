/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { exitPurposeForRequest } from "@/lib/movement-exits";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import { isEarnExitOrRead } from "@/routes/earn/exits";
import { readApprovalExecutionTarget } from "@/services/policy/approved-operation-replay";
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
import {
  createWalletSchema,
  deleteWalletSchema,
  initializeSigningSchema,
  setDefaultWalletSchema,
  signerCheckSchema,
  switchSigningSchema,
  updateWalletSchema,
} from "./schemas";

const APPROVAL_REQUEST_PATH =
  /^\/v1\/wallets\/approval-requests(?:\/([^/]+)(?:\/(approve|reject|cancel))?)?$/;

/**
 * Exits stay open after the production entitlement is lost (ADR 0002,
 * APE-351, HOO-1955), including the approvals some of them wait on. Without the
 * entitlement a production organization may still read its approval requests,
 * reject or cancel any of them (that stops money), and approve one whose
 * stored operation is itself an exit (`lib/movement-exits.ts`). Approving anything else stays
 * refused, so no new money movement can be released here.
 */
async function approvalMayReleaseExit(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const match = APPROVAL_REQUEST_PATH.exec(c.req.path);
  if (!match) {
    return false;
  }
  const [, approvalRequestId, action] = match;
  if (action === undefined) {
    return c.req.method === "GET";
  }
  if (c.req.method !== "POST" || approvalRequestId === undefined) {
    return false;
  }
  if (action !== "approve") {
    return true;
  }
  const organizationId = c.get("apiKey")?.organizationId ?? c.get("clerk")?.organizationId;
  if (!organizationId) {
    return false;
  }
  const target = await readApprovalExecutionTarget(c.env, organizationId, approvalRequestId);
  // Earn reads stay open too; every other module's exits come from the
  // shared allowlist (HOO-1955).
  return (
    target !== null &&
    (isEarnExitOrRead(target.method, target.path) ||
      exitPurposeForRequest(target.method, target.path) !== null)
  );
}

const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware());
wallets.use("*", projectContextMiddleware({ allowUnentitledProduction: approvalMayReleaseExit }));

// Initialize signing (requires admin)
wallets.post(
  "/initialize",
  requirePermissions("custody:admin"),
  validateBody(initializeSigningSchema),
  initializeSigning
);
wallets.post(
  "/switch",
  requirePermissions("custody:admin"),
  validateBody(switchSigningSchema),
  switchSigning
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
wallets.post(
  "/default-wallet",
  requirePermissions("custody:admin"),
  validateBody(setDefaultWalletSchema),
  setDefaultWallet
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
