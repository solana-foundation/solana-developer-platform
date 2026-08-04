import { z } from "zod";
import { mapPrivateChannelTransferRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { createChannelTransfer, mapPrivateChannelError } from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import { getPrivateChannelTransferRepository } from "../context";
import {
  createTransferBodySchema,
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

/** POST /channels/:channelId/transfers. */
export async function createPrivateChannelTransfer(c: AppContext) {
  const channelId = parseChannelId(c);
  const body = await c.req.json().catch(() => null);
  const parsed = createTransferBodySchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid transfer request", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    const context = await resolveTransferCreateContext(c, {
      channelId,
      walletId: parsed.data.walletId,
      recipientVerifiedWalletId: parsed.data.recipientVerifiedWalletId,
    });
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      userId: context.auth.userId,
    });
    const transfer = await createChannelTransfer(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      channelId,
      wallet: context.wallet,
      signer: context.signer,
      recipient: context.recipient,
      amount: parsed.data.amount,
      mint: parsed.data.mint,
      gatewayAuth,
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
