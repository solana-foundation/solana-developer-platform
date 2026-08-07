import { z } from "zod";
import { mapPrivateChannelInstanceRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound, unauthorized, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import {
  createChannelDeposit,
  getChannelDeposit,
  listChannelDeposits,
  mapPrivateChannelError,
} from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import { getPrivateChannelInstanceRepository } from "../context";
import { createDepositBodySchema, depositIdParamSchema } from "../schemas";

async function loadActiveInstance(c: AppContext, organizationId: string, projectId: string) {
  const row = await getPrivateChannelInstanceRepository(c).getActiveByProject({
    organizationId,
    projectId,
  });
  if (!row) {
    throw notFound("Active private channel instance");
  }
  return mapPrivateChannelInstanceRow(row);
}

/**
 * POST /deposits — create + broadcast a deposit from a custody wallet into the
 * instance escrow (devnet), crediting `recipient` (defaults to the depositor) in
 * the channel. Feature-gated + `payments:write`. Returns the deposit DTO with its
 * current status (submitted/confirmed, or failed with a reason).
 *
 * TODO(visibility): like the balance read, this is under-gated — a non-admin should
 * only be able to deposit from their own verified wallet and into channels they
 * belong to, per `private_channel_verified_wallets` and
 * `private_channel_memberships`.
 */
export async function createPrivateChannelDeposit(c: AppContext) {
  const body = await c.req.json().catch(() => null);
  const parsed = createDepositBodySchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid deposit request", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    const { auth, wallets } = await resolveScope(c);
    const userId = auth.userId;
    if (!userId) {
      throw unauthorized("Private Channel deposits require a user session.");
    }
    const projectId = requireProjectId(c);
    const instance = await loadActiveInstance(c, auth.organizationId, projectId);

    // Source wallet must be a custody wallet we can sign for.
    const depositorPubkey = resolveWalletAddress(wallets, parsed.data.walletId, "walletId", auth, [
      "wallets:read",
    ]);
    const wallet = wallets.find((w) => w.publicKey === depositorPubkey);
    if (!wallet) {
      throw walletNotFound();
    }

    // Recipient may be another member's wallet/address; defaults to the depositor.
    const recipient = parsed.data.recipient
      ? resolveWalletAddress(wallets, parsed.data.recipient, "recipient", auth, ["wallets:read"])
      : undefined;

    // Auth-enabled instances JWT-gate the gateway baseline read.
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance,
      organizationId: auth.organizationId,
      projectId,
      userId,
    });

    const deposit = await createChannelDeposit(c.env, {
      instance,
      organizationId: auth.organizationId,
      projectId,
      userId,
      wallet,
      amount: parsed.data.amount,
      mint: parsed.data.mint,
      recipient,
      gatewayAuth,
    });
    return success(c, deposit);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}

/** GET /deposits/:id — read one deposit for the project. */
export async function getPrivateChannelDepositById(c: AppContext) {
  const parsed = depositIdParamSchema.safeParse({ id: c.req.param("id") });
  if (!parsed.success) {
    throw badRequest("Invalid deposit id");
  }

  try {
    const auth = getAuth(c);
    const projectId = requireProjectId(c);
    const deposit = await getChannelDeposit(c.env, {
      organizationId: auth.organizationId,
      projectId,
      id: parsed.data.id,
    });
    if (!deposit) {
      throw notFound("Deposit");
    }
    return success(c, deposit);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}

/** GET /deposits — list the project's deposits, newest first. */
export async function listPrivateChannelDeposits(c: AppContext) {
  try {
    const auth = getAuth(c);
    const projectId = requireProjectId(c);
    const deposits = await listChannelDeposits(c.env, {
      organizationId: auth.organizationId,
      projectId,
    });
    return success(c, { deposits });
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}
