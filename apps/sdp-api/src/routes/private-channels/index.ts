import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import type { Env } from "@/types/env";
import {
  addChannelMembership,
  connectPrivateChannelInstance,
  createChannel,
  createPrivateChannelDeposit,
  createPrivateChannelTransfer,
  createPrivateChannelWithdrawal,
  deleteChannel,
  deletePrivateChannelInstance,
  deletePrivateChannelUser,
  deleteVerifiedWallet,
  disconnectPrivateChannelInstance,
  getAuthenticatedPrivateChannelUser,
  getChannel,
  getPrivateChannelBalance,
  getPrivateChannelDepositById,
  getPrivateChannelHealth,
  getPrivateChannelInstance,
  getPrivateChannelOverview,
  getPrivateChannelTransferById,
  getPrivateChannelUser,
  getPrivateChannelWithdrawalById,
  invitePrivateChannelUser,
  listChannelEvents,
  listChannels,
  listPrivateChannelDeposits,
  listPrivateChannelEventReferences,
  listPrivateChannelTransferRecipients,
  listPrivateChannelTransfers,
  listPrivateChannelUsers,
  listPrivateChannelWithdrawals,
  listProjectEvents,
  listVerifiedWallets,
  probePrivateChannelConnection,
  removeChannelMembership,
  verifyWallet,
} from "./handlers";

const privateChannels = new Hono<{ Bindings: Env }>();

/**
 * Router-wide gate: 403 FORBIDDEN unless the feature flag is enabled. Applied
 * once as middleware so every current and future route inherits it. Kept separate
 * from "is an instance configured/ready" (that check belongs to the handlers).
 */
async function requirePrivateChannelsFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isPrivateChannelsEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Private Channels are not enabled for this environment.");
  }
  await next();
}

privateChannels.use("*", requirePrivateChannelsFeature);
privateChannels.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
privateChannels.use("*", projectContextMiddleware());

// --- /health --------------------------------------------------------------
// Gateway-only probe of a caller-supplied URL. Returns PrivateChannelHealth DTO.
privateChannels.get("/health", requirePermissions("payments:read"), getPrivateChannelHealth);

// --- /probe ---------------------------------------------------------------
// Full connect-time probe (gateway + chain RPC). What the connect flow's
// re-probe runs; wired here so the web's Test-connection matches Connect.
privateChannels.post("/probe", requirePermissions("payments:read"), probePrivateChannelConnection);

// --- /instance ------------------------------------------------------------
const instance = new Hono<{ Bindings: Env }>();
instance.get("/", requirePermissions("payments:read"), getPrivateChannelInstance);
instance.post("/", requirePermissions("payments:write"), connectPrivateChannelInstance);
instance.delete("/", requirePermissions("payments:write"), deletePrivateChannelInstance);
instance.post(
  "/disconnect",
  requirePermissions("payments:write"),
  disconnectPrivateChannelInstance
);
instance.get("/overview", requirePermissions("payments:read"), getPrivateChannelOverview);
privateChannels.route("/instance", instance);

// --- /balance -------------------------------------------------------------
// Read an owner's channel token balance (per wallet+mint) through the gateway.
privateChannels.get("/balance", requirePermissions("payments:read"), getPrivateChannelBalance);

// --- /deposits ------------------------------------------------------------
// Escrow deposits from a custody wallet into the instance (devnet), tracked
// pending -> submitted -> confirmed.
privateChannels.post(
  "/deposits",
  requirePermissions("payments:write"),
  createPrivateChannelDeposit
);
privateChannels.get("/deposits", requirePermissions("payments:read"), listPrivateChannelDeposits);
privateChannels.get(
  "/deposits/:id",
  requirePermissions("payments:read"),
  getPrivateChannelDepositById
);

// --- /withdrawals ---------------------------------------------------------
// Burn the custody wallet's channel-chain balance (relayed to the gateway); the
// operator releases real USDC on devnet. Tracked pending -> submitted ->
// confirmed -> settled.
privateChannels.post(
  "/withdrawals",
  requirePermissions("payments:write"),
  createPrivateChannelWithdrawal
);
privateChannels.get(
  "/withdrawals",
  requirePermissions("payments:read"),
  listPrivateChannelWithdrawals
);
privateChannels.get(
  "/withdrawals/:id",
  requirePermissions("payments:read"),
  getPrivateChannelWithdrawalById
);

// --- /events --------------------------------------------------------------
privateChannels.get(
  "/events/references",
  requirePermissions("payments:read"),
  listPrivateChannelEventReferences
);
privateChannels.get("/events", requirePermissions("payments:read"), listProjectEvents);

// --- /channels ------------------------------------------------------------
// Logical channels: instance-scoped metadata, enforced entirely by SDP.
privateChannels.get("/channels", requirePermissions("payments:read"), listChannels);
privateChannels.post("/channels", requirePermissions("payments:write"), createChannel);
privateChannels.get("/channels/:id", requirePermissions("payments:read"), getChannel);
privateChannels.get("/channels/:id/events", requirePermissions("payments:read"), listChannelEvents);
privateChannels.delete("/channels/:id", requirePermissions("payments:write"), deleteChannel);
privateChannels.get(
  "/channels/:channelId/transfer-recipients",
  requirePermissions("payments:read"),
  listPrivateChannelTransferRecipients
);
privateChannels.post(
  "/channels/:channelId/transfers",
  requirePermissions("payments:write"),
  createPrivateChannelTransfer
);

// --- /transfers -----------------------------------------------------------
// Project-scoped transfer history survives channel/instance lifecycle changes.
privateChannels.get("/transfers", requirePermissions("payments:read"), listPrivateChannelTransfers);
privateChannels.get(
  "/transfers/:id",
  requirePermissions("payments:read"),
  getPrivateChannelTransferById
);

// --- /wallets -------------------------------------------------------------
// Wallet verification: the gate for money-movement. Verifying signs an SPC auth
// challenge with the custody wallet (any SDP provider) server-side and records
// it; deleting revokes it with SPC and removes the row.
privateChannels.get("/wallets", requirePermissions("payments:read"), listVerifiedWallets);
privateChannels.post(
  "/wallets/:walletId/verify",
  requirePermissions("payments:write"),
  verifyWallet
);
privateChannels.delete(
  "/wallets/:pubkey",
  requirePermissions("payments:write"),
  deleteVerifiedWallet
);

// --- /channels/:channelId/memberships -------------------------------------
// Junction between a channel and an invited workspace user.
privateChannels.post(
  "/channels/:channelId/memberships",
  requirePermissions("payments:write"),
  addChannelMembership
);
privateChannels.delete(
  "/channels/:channelId/memberships/:privateChannelUserId",
  requirePermissions("payments:write"),
  removeChannelMembership
);

// --- /users ---------------------------------------------------------------
// Workspace-level invites: one row per SDP user with SPC credentials.
privateChannels.get("/users", requirePermissions("payments:read"), listPrivateChannelUsers);
privateChannels.post("/users", requirePermissions("payments:write"), invitePrivateChannelUser);
// /users/me must come before /users/:id so `me` isn't matched as a param.
privateChannels.get(
  "/users/me",
  requirePermissions("payments:read"),
  getAuthenticatedPrivateChannelUser
);
privateChannels.get(
  "/users/:privateChannelUserId",
  requirePermissions("payments:read"),
  getPrivateChannelUser
);
privateChannels.delete(
  "/users/:privateChannelUserId",
  requirePermissions("payments:write"),
  deletePrivateChannelUser
);

export default privateChannels;
