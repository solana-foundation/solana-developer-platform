import { privateChannelInstanceInputSchema } from "@sdp/private-channels";
import { PRIVATE_CHANNEL_EVENT_FAMILY_VALUES } from "@sdp/types";
import { z } from "zod";
import { privateChannelTransferAmountSchema } from "@/lib/private-channel-transfer-amount";

// `confirmReactivate` is a client acknowledgement that we're about to overwrite
// config on an existing (inactive) row that downstream data may be bound to.
export const connectPrivateChannelInstanceSchema = z.intersection(
  privateChannelInstanceInputSchema,
  z.object({ confirmReactivate: z.boolean().optional() })
);

export type ConnectPrivateChannelInstanceInput = z.infer<
  typeof connectPrivateChannelInstanceSchema
>;

/** Body for `POST /probe`: the three URLs the connect flow re-probes. */
export const probeConnectionSchema = z.object({
  gatewayUrl: z.string().min(1),
  chainRpcUrl: z.string().min(1),
  authUrl: z.string().min(1),
});

/** Query params for `GET /health`. */
export const healthQuerySchema = z.object({
  gatewayUrl: z.string().min(1),
});

/** Request body for `POST /channels`. Name content is validated in the domain layer. */
export const createChannelBodySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

/**
 * Query params for `GET /balance`: `owner` (a `walletId` from GET /v1/wallets, a
 * wallet public key, or a raw Solana address) and an optional `mint` (defaults to
 * the instance cluster's USDC mint).
 */
export const balanceQuerySchema = z.object({
  owner: z.string().min(1),
  mint: z.string().min(1).optional(),
});

/**
 * Body for `POST /deposits`. `walletId` is the source custody wallet (a `walletId`
 * from GET /v1/wallets or its public key); `amount` is a decimal string; optional
 * `recipient` (walletId or address) is credited in the channel, defaulting to the
 * depositor.
 */
export const createDepositBodySchema = z.object({
  walletId: z.string().min(1),
  amount: z.string().min(1),
  recipient: z.string().min(1).optional(),
});

/** Path param for `GET /deposits/:id`. */
export const depositIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * Body for `POST /withdrawals`. `walletId` is the custody wallet whose channel-chain
 * balance is burned (a `walletId` from GET /v1/wallets or its public key); `amount`
 * is a decimal string; optional `destination` (address) receives the operator's
 * devnet USDC release, defaulting to the owner wallet.
 */
export const createWithdrawalBodySchema = z.object({
  walletId: z.string().min(1),
  amount: z.string().min(1),
  destination: z.string().min(1).optional(),
});

/** Path param for `GET /withdrawals/:id`. */
export const withdrawalIdParamSchema = z.object({
  id: z.string().min(1),
});

/** Path param shared by channel-scoped transfer routes. */
export const transferChannelIdParamSchema = z.object({
  channelId: z.string().min(1),
});

/** Body for `POST /channels/:channelId/transfers`. */
export const createTransferBodySchema = z.object({
  walletId: z.string().min(1),
  recipientVerifiedWalletId: z.string().min(1),
  amount: privateChannelTransferAmountSchema,
});

/** Path param for `GET /transfers/:id`. */
export const transferIdParamSchema = z.object({
  id: z.string().min(1),
});

/** Optional project-history filter for `GET /transfers`. */
export const transferListQuerySchema = z.object({
  channelId: z.string().min(1).optional(),
});

/** Query params for `GET /channels/:id/events` and `GET /events`. */
export const privateChannelEventsQuerySchema = z.object({
  family: z.enum(PRIVATE_CHANNEL_EVENT_FAMILY_VALUES).optional(),
  type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().min(1).optional(),
});

/** Invite an existing SDP project user to the SPC workspace. */
export const inviteMemberBodySchema = z.object({
  userId: z.string().min(1),
});

/** Body for `POST /channels/:channelId/memberships`. */
export const addMembershipBodySchema = z.object({
  privateChannelUserId: z.string().min(1),
});
