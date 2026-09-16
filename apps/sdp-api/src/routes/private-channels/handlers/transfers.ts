import { mapPrivateChannelTransferRow, type PrivateChannelTransferRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { isAbandonedReservation } from "@/lib/idempotency";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { createChannelTransfer, mapPrivateChannelError } from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import { resolveAbandonedTransferReservation } from "@/services/private-channels/transfer";
import { createPrivateChannelSigner } from "@/services/private-channels/wallet-access";
import type { AppContext } from "../context";
import {
  getPrivateChannelTransferRepository,
  loadPrivateChannelProjectRpcClient,
} from "../context";
import { requireIdempotencyKey } from "../helpers";
import { authorizeMovementReplay, matchesTransferReplay, requireMovementWrite } from "../replay";
import {
  type createTransferBodySchema,
  transferChannelIdParamSchema,
  transferIdParamSchema,
  transferListQuerySchema,
} from "../schemas";
import { resolveTransferCreateContext, resolveTransferRecipients } from "../transfer-access";

function parseChannelId(c: AppContext): string {
  const parsed = transferChannelIdParamSchema.safeParse({
    channelId: c.req.param("channelId"),
  });
  if (!parsed.success) {
    throw badRequest("Invalid channel id");
  }
  return parsed.data.channelId;
}

/** GET /channels/:channelId/transfer-recipients. */
export async function listPrivateChannelTransferRecipients(c: AppContext) {
  const recipients = await resolveTransferRecipients(c, parseChannelId(c));
  return success(c, { recipients });
}

/**
 * POST /channels/:channelId/transfers.
 *
 * `Idempotency-Key` is required. The reservation it takes is what makes a retry
 * return this transfer instead of spending the sender's balance a second time.
 */
export async function createPrivateChannelTransfer(
  c: ValidatedBodyContext<typeof createTransferBodySchema>
) {
  const channelId = parseChannelId(c);
  const body = c.req.valid("json");

  try {
    const idempotencyKey = requireIdempotencyKey(c, "Private Channels transfers");
    await requireMovementWrite(c);
    const auth = getAuth(c);
    const repo = getPrivateChannelTransferRepository(c);
    const onReplay = async (row: PrivateChannelTransferRow) => {
      matchesTransferReplay(row, { ...body, channelId });
      const context = await authorizeMovementReplay(c, row, async () => {
        const original = await resolveTransferCreateContext(c, {
          channelId: row.channel_id,
          walletId: row.sender_wallet_id,
          recipientVerifiedWalletId: row.recipient_verified_wallet_id,
        });
        if (
          original.actor.id !== row.sender_private_channel_user_id ||
          original.recipient.pubkey !== row.recipient ||
          original.recipient.privateChannelUserId !== row.recipient_private_channel_user_id
        ) {
          throw conflict("The original transfer's participants cannot be authorized");
        }
        return original;
      });
      if (isAbandonedReservation(row)) {
        const gatewayAuth = await resolveGatewayAuth(c.env, {
          instance: context.instance,
          organizationId: auth.organizationId,
          projectId: context.projectId,
          userId: auth.userId,
        });
        return resolveAbandonedTransferReservation(c.env, repo, row, {
          gatewayUrl: context.instance.gatewayUrl,
          gatewayAuth,
          sdpUserId: auth.id,
        });
      }
      return mapPrivateChannelTransferRow(row);
    };
    const replay = await repo.findTransferByIdempotency({
      organizationId: auth.organizationId,
      projectId: requireProjectId(c),
      idempotencyKey,
    });
    if (replay) return success(c, await onReplay(replay));
    const context = await resolveTransferCreateContext(c, {
      channelId,
      walletId: body.walletId,
      recipientVerifiedWalletId: body.recipientVerifiedWalletId,
    });
    const signer = await createPrivateChannelSigner(
      c.env,
      context.auth.organizationId,
      context.projectId,
      context.wallet
    );
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      userId: context.auth.userId,
    });
    const projectRpc = await loadPrivateChannelProjectRpcClient(c);
    const transfer = await createChannelTransfer(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      channelId,
      sdpUserId: context.auth.id,
      wallet: context.wallet,
      signer,
      onReplay,
      recipient: context.recipient,
      amount: body.amount,
      mint: body.mint,
      idempotencyKey,
      gatewayAuth,
      projectRpc,
    });
    return success(c, transfer);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}

/** GET /transfers/:id — read one transfer within the request's project scope. */
export async function getPrivateChannelTransferById(c: AppContext) {
  const parsed = transferIdParamSchema.safeParse({ id: c.req.param("id") });
  if (!parsed.success) {
    throw badRequest("Invalid transfer id");
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const row = await getPrivateChannelTransferRepository(c).getTransferById({
    organizationId: auth.organizationId,
    projectId,
    id: parsed.data.id,
  });
  if (!row) {
    throw notFound("Transfer");
  }
  return success(c, mapPrivateChannelTransferRow(row));
}

/** GET /transfers — project history, optionally narrowed to one channel id. */
export async function listPrivateChannelTransfers(c: AppContext) {
  const parsed = transferListQuerySchema.safeParse({
    channelId: c.req.query("channelId"),
  });
  if (!parsed.success) {
    throw badRequest("Invalid transfer query");
  }

  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const rows = await getPrivateChannelTransferRepository(c).listTransfersByProject({
    organizationId: auth.organizationId,
    projectId,
    channelId: parsed.data.channelId,
  });
  return success(c, { transfers: rows.map(mapPrivateChannelTransferRow) });
}
