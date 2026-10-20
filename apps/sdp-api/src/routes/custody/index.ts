/**
 * Wallet Routes
 *
 * Manages organization-specific signing key configuration and wallet provisioning.
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { authorize, authorizeNone } from "@/middleware/authorize";
import { idempotent } from "@/middleware/idempotency";
import { meteredQuota } from "@/middleware/metered-quota";
import { replayFromRecord } from "@/middleware/movement-steps";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { getConfigs } from "@/routes/custody/handlers/configs";
import { initializeSigning } from "@/routes/custody/handlers/provider";
import { signerCheck } from "@/routes/custody/handlers/signer-check";
import {
  createWallet,
  deleteWallet,
  findCustodyWalletCreateReplay,
  getPublicKey,
  getWalletAggregate,
  getWalletById,
  listWallets,
  updateWallet,
} from "@/routes/custody/handlers/wallets";
import type { Env } from "@/types/env";
import {
  authorizeCreateWallet,
  authorizeDeleteWallet,
  authorizeSignerCheck,
  authorizeUpdateWallet,
} from "./access";
import {
  createWalletSchema,
  deleteWalletSchema,
  initializeSigningSchema,
  signerCheckSchema,
  updateWalletSchema,
} from "./schemas";

export const wallets = new Hono<{ Bindings: Env }>();

// All routes require authentication
wallets.use("*", unifiedAuthMiddleware());
wallets.use("*", projectContextMiddleware());

// Initialize signing (requires admin)
wallets.post(
  "/initialize",
  requireAction("wallets.configure"),
  validateBody(initializeSigningSchema),
  authorizeNone("connects a provider in the caller's own project"),
  idempotent({ key: "accepted", serverErrors: "store" }),
  initializeSigning
);
wallets.post(
  "/",
  requireAction("wallets.manage"),
  validateBody(createWalletSchema),
  authorize(authorizeCreateWallet),
  // A retry the key could not answer (a crash, a takeover) finds the wallet row.
  idempotent({ key: "accepted", serverErrors: "store", recovery: "record" }),
  replayFromRecord(findCustodyWalletCreateReplay),
  createWallet
);
// Deleting a wallet deletes it at the custody provider too: irreversible.
wallets.delete(
  "/",
  requireAction("wallets.execute"),
  validateBody(deleteWalletSchema),
  authorize(authorizeDeleteWallet),
  idempotent({ key: "accepted", serverErrors: "store" }),
  deleteWallet
);
wallets.patch(
  "/:walletId",
  requireAction("wallets.manage"),
  validateBody(updateWalletSchema),
  authorize(authorizeUpdateWallet),
  idempotent({ key: "accepted", serverErrors: "store" }),
  updateWallet
);
wallets.post(
  "/signer-check",
  requireAction("wallets.execute"),
  validateBody(signerCheckSchema),
  authorize(authorizeSignerCheck),
  // Before the quota, so a replayed check is never counted again.
  idempotent({ key: "accepted", serverErrors: "store" }),
  meteredQuota({ name: "signer-check", actorMax: 2, orgMax: 10 }),
  signerCheck
);

// Read configuration and wallets
wallets.get("/configs", requireAction("wallets.read"), getConfigs);
wallets.get("/", requireAction("wallets.read"), listWallets);
wallets.get("/aggregate", requireAction("wallets.read"), getWalletAggregate);
wallets.get("/public-key", requireAction("wallets.read"), getPublicKey);
wallets.get("/:walletId", requireAction("wallets.read"), getWalletById);
