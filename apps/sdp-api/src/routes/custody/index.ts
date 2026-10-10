/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { idempotent } from "@/middleware/idempotency";
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
  getConfigs,
  getPublicKey,
  getWalletAggregate,
  getWalletById,
  initializeSigning,
  listApprovalRequests,
  listWallets,
  rejectApprovalRequest,
  signerCheck,
  updateWallet,
} from "./handlers";
import { authorizeSignerCheckReplay } from "./handlers/signer-check";
import {
  createWalletSchema,
  deleteWalletSchema,
  initializeSigningSchema,
  signerCheckSchema,
  updateWalletSchema,
} from "./schemas";

const APPROVAL_REQUEST_PATH =
  /^\/v1\/wallets\/approval-requests(?:\/([^/]+)(?:\/(approve|reject|cancel))?)?$/;

/**
 * Earn exits stay open after the production entitlement is lost (ADR 0002,
 * APE-351), including the approvals some of them wait on. Without the
 * entitlement a production organization may still read its approval requests,
 * reject or cancel any of them (that stops money), and approve one whose
 * stored operation is itself an Earn exit. Approving anything else stays
 * refused, so no new money movement can be released here.
 */
async function approvalMayReleaseEarnExit(c: Context<{ Bindings: Env }>): Promise<boolean> {
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
  return target !== null && isEarnExitOrRead(target.method, target.path);
}

const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware());
wallets.use(
  "*",
  projectContextMiddleware({ allowUnentitledProduction: approvalMayReleaseEarnExit })
);

// Initialize signing (requires admin)
wallets.post(
  "/initialize",
  requirePermissions("custody:admin"),
  idempotent({ key: "accepted" }),
  validateBody(initializeSigningSchema),
  initializeSigning
);
wallets.post(
  "/",
  requirePermissions("custody:admin"),
  idempotent({ key: "accepted" }),
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
  idempotent({ key: "accepted" }),
  validateBody(updateWalletSchema),
  updateWallet
);
wallets.post(
  "/signer-check",
  requirePermissions("wallets:write"),
  idempotent({ key: "accepted", authorizeReplay: authorizeSignerCheckReplay }),
  validateBody(signerCheckSchema),
  meteredQuota({ name: "signer-check", actorMax: 2, orgMax: 10 }),
  signerCheck
);

// Read configuration and wallets
wallets.get("/configs", requirePermissions("wallets:read"), getConfigs);
wallets.get("/", requirePermissions("wallets:read"), listWallets);
wallets.get("/aggregate", requirePermissions("wallets:read"), getWalletAggregate);
wallets.get("/public-key", requirePermissions("wallets:read"), getPublicKey);
wallets.get("/approval-requests", requirePermissions("wallets:read"), listApprovalRequests);
wallets.get(
  "/approval-requests/:approvalRequestId",
  requirePermissions("wallets:read"),
  getApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/approve",
  requirePermissions("wallets:write"),
  idempotent({ key: "required" }),
  approveApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/reject",
  requirePermissions("wallets:write"),
  idempotent({ key: "accepted" }),
  rejectApprovalRequest
);
wallets.post(
  "/approval-requests/:approvalRequestId/cancel",
  requirePermissions("wallets:write"),
  idempotent({ key: "accepted" }),
  cancelApprovalRequest
);
wallets.get("/:walletId", requirePermissions("wallets:read"), getWalletById);

export default wallets;
