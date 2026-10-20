import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isPrivateChannelsEnabled } from "@/lib/feature-flags";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import { getPrivateChannelBalance } from "@/routes/private-channels/handlers/balance";
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
} from "@/routes/private-channels/handlers/channels";
import {
  createPrivateChannelDeposit,
  getPrivateChannelDepositById,
  listPrivateChannelDeposits,
} from "@/routes/private-channels/handlers/deposits";
import { listPrivateChannelEventReferences } from "@/routes/private-channels/handlers/event-references";
import { listChannelEvents, listProjectEvents } from "@/routes/private-channels/handlers/events";
import { getPrivateChannelHealth } from "@/routes/private-channels/handlers/health";
import {
  connectPrivateChannelInstance,
  deletePrivateChannelInstance,
  disconnectPrivateChannelInstance,
  getPrivateChannelInstance,
  updatePrivateChannelInstance,
} from "@/routes/private-channels/handlers/instance";
import {
  addPrincipalChannelMembership,
  createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal,
  listPrivateChannelPrincipals,
  removePrincipalChannelMembership,
} from "@/routes/private-channels/handlers/members";
import { getPrivateChannelOverview } from "@/routes/private-channels/handlers/overview";
import { probePrivateChannelConnection } from "@/routes/private-channels/handlers/probe";
import { listPrivateChannelTokenEligibility } from "@/routes/private-channels/handlers/tokens";
import {
  createPrivateChannelTransfer,
  getPrivateChannelTransferById,
  listPrivateChannelTransferRecipients,
  listPrivateChannelTransfers,
} from "@/routes/private-channels/handlers/transfers";
import {
  deleteVerifiedWallet,
  listVerifiedWallets,
  verifyWallet,
} from "@/routes/private-channels/handlers/wallets";
import {
  createPrivateChannelWithdrawal,
  getPrivateChannelWithdrawalById,
  listPrivateChannelWithdrawals,
} from "@/routes/private-channels/handlers/withdrawals";
import type { Env } from "@/types/env";
import {
  addPrincipalMembershipBodySchema,
  connectPrivateChannelInstanceSchema,
  createChannelBodySchema,
  createDepositBodySchema,
  createPrincipalBodySchema,
  createTransferBodySchema,
  createWithdrawalBodySchema,
  probeConnectionSchema,
  updatePrivateChannelInstanceSchema,
  verifyWalletBodySchema,
} from "./schemas";

export const privateChannels = new Hono<{ Bindings: Env }>();

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
privateChannels.use("*", unifiedAuthMiddleware());
privateChannels.use("*", projectContextMiddleware());

// --- /health --------------------------------------------------------------
// Gateway-only probe of a caller-supplied URL. Returns PrivateChannelHealth DTO.
privateChannels.get("/health", requireAction("private_channels.read"), getPrivateChannelHealth);

// --- /probe ---------------------------------------------------------------
// Full connect-time probe (gateway + chain RPC). What the connect flow's
// re-probe runs; wired here so the web's Test-connection matches Connect.
privateChannels.post(
  "/probe",
  requireAction("private_channels.read"),
  validateBody(probeConnectionSchema),
  probePrivateChannelConnection
);

// --- /instance ------------------------------------------------------------
const instance = new Hono<{ Bindings: Env }>();
instance.get("/", requireAction("private_channels.read"), getPrivateChannelInstance);
instance.post(
  "/",
  requireAction("private_channels.configure"),
  validateBody(connectPrivateChannelInstanceSchema),
  connectPrivateChannelInstance
);
instance.patch(
  "/",
  requireAction("private_channels.configure"),
  validateBody(updatePrivateChannelInstanceSchema),
  updatePrivateChannelInstance
);
instance.delete("/", requireAction("private_channels.configure"), deletePrivateChannelInstance);
instance.post(
  "/disconnect",
  requireAction("private_channels.configure"),
  disconnectPrivateChannelInstance
);
instance.get("/overview", requireAction("private_channels.read"), getPrivateChannelOverview);
privateChannels.route("/instance", instance);

// --- /balance -------------------------------------------------------------
// Read an owner's channel token balance (per wallet+mint) through the gateway.
privateChannels.get("/balance", requireAction("private_channels.read"), getPrivateChannelBalance);

// --- /tokens --------------------------------------------------------------
// Registered tokens with per-instance on-chain enablement and exclusion reasons.
privateChannels.get(
  "/tokens",
  requireAction("private_channels.read"),
  listPrivateChannelTokenEligibility
);

// --- /deposits ------------------------------------------------------------
// Escrow deposits from a custody wallet into the instance (devnet), tracked
// pending -> submitted -> confirmed.
privateChannels.post(
  "/deposits",
  requireAction("private_channels.execute"),
  validateBody(createDepositBodySchema),
  createPrivateChannelDeposit
);
privateChannels.get(
  "/deposits",
  requireAction("private_channels.read"),
  listPrivateChannelDeposits
);
privateChannels.get(
  "/deposits/:id",
  requireAction("private_channels.read"),
  getPrivateChannelDepositById
);

// --- /withdrawals ---------------------------------------------------------
// Burn the custody wallet's channel-chain balance (relayed to the gateway); the
// operator releases real USDC on devnet. Tracked pending -> submitted ->
// confirmed -> settled.
privateChannels.post(
  "/withdrawals",
  requireAction("private_channels.execute"),
  validateBody(createWithdrawalBodySchema),
  createPrivateChannelWithdrawal
);
privateChannels.get(
  "/withdrawals",
  requireAction("private_channels.read"),
  listPrivateChannelWithdrawals
);
privateChannels.get(
  "/withdrawals/:id",
  requireAction("private_channels.read"),
  getPrivateChannelWithdrawalById
);

// --- /events --------------------------------------------------------------
privateChannels.get(
  "/events/references",
  requireAction("private_channels.read"),
  listPrivateChannelEventReferences
);
privateChannels.get("/events", requireAction("private_channels.read"), listProjectEvents);

// --- /channels ------------------------------------------------------------
// Logical channels: instance-scoped metadata, enforced entirely by SDP.
privateChannels.get("/channels", requireAction("private_channels.read"), listChannels);
privateChannels.post(
  "/channels",
  requireAction("private_channels.manage"),
  validateBody(createChannelBodySchema),
  createChannel
);
privateChannels.get("/channels/:id", requireAction("private_channels.read"), getChannel);
privateChannels.get(
  "/channels/:id/events",
  requireAction("private_channels.read"),
  listChannelEvents
);
privateChannels.delete("/channels/:id", requireAction("private_channels.manage"), deleteChannel);
privateChannels.get(
  "/channels/:channelId/transfer-recipients",
  requireAction("private_channels.read"),
  listPrivateChannelTransferRecipients
);
privateChannels.post(
  "/channels/:channelId/transfers",
  requireAction("private_channels.execute"),
  validateBody(createTransferBodySchema),
  createPrivateChannelTransfer
);

// --- /transfers -----------------------------------------------------------
// Project-scoped transfer history survives channel/instance lifecycle changes.
privateChannels.get(
  "/transfers",
  requireAction("private_channels.read"),
  listPrivateChannelTransfers
);
privateChannels.get(
  "/transfers/:id",
  requireAction("private_channels.read"),
  getPrivateChannelTransferById
);

// --- /wallets -------------------------------------------------------------
// Wallet verification: the gate for money-movement. Verifying signs an SPC auth
// challenge with the custody wallet (any SDP provider) server-side and records
// it; deleting revokes it with SPC and removes the row.
privateChannels.get("/wallets", requireAction("private_channels.read"), listVerifiedWallets);
privateChannels.post(
  "/wallets/:walletId/verify",
  requireAction("private_channels.execute"),
  validateBody(verifyWalletBodySchema),
  verifyWallet
);
privateChannels.delete(
  "/wallets/:pubkey",
  requireAction("private_channels.manage"),
  deleteVerifiedWallet
);

// --- /channels/:channelId/principals --------------------------------------
// Junction between a channel and a project-scoped SPC principal.
privateChannels.post(
  "/channels/:channelId/principals",
  requireAction("private_channels.configure"),
  validateBody(addPrincipalMembershipBodySchema),
  addPrincipalChannelMembership
);
privateChannels.delete(
  "/channels/:channelId/principals/:principalId",
  requireAction("private_channels.configure"),
  removePrincipalChannelMembership
);

// --- /principals ----------------------------------------------------------
// Project-scoped financial/operational identities. They are not SDP users.
privateChannels.get(
  "/principals",
  requireAction("private_channels.read"),
  listPrivateChannelPrincipals
);
privateChannels.post(
  "/principals",
  requireAction("private_channels.configure"),
  validateBody(createPrincipalBodySchema),
  createPrivateChannelPrincipal
);
privateChannels.delete(
  "/principals/:principalId",
  requireAction("private_channels.configure"),
  disablePrivateChannelPrincipal
);
