import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  createChannelDeposit,
  getChannelDeposit,
  listChannelDeposits,
  mapPrivateChannelError,
} from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import { loadPrivateChannelProjectRpcClient } from "../context";
import { requireIdempotencyKey } from "../helpers";
import { type createDepositBodySchema, depositIdParamSchema } from "../schemas";
import { resolveDepositCreateContext } from "../value-movement-access";

/**
 * POST /deposits — create + broadcast a deposit from a custody wallet into the
 * instance escrow, crediting `recipient` (defaults to the depositor) in the
 * channel. Feature-gated + `payments:write`. Returns the deposit DTO with its
 * current status (submitted/confirmed, or failed with a reason).
 *
 * Authorization lives entirely in `resolveDepositCreateContext`: the caller must
 * be an SPC member of the project's active instance, the source custody wallet
 * must be one THEY verified there, and the credited recipient must be an address
 * verified on the instance. `payments:write` alone is not enough — it says
 * nothing about which member owns which wallet.
 *
 * `Idempotency-Key` is required. The reservation it takes is what makes a retry
 * return this deposit instead of broadcasting a second escrow transfer.
 */
export async function createPrivateChannelDeposit(
  c: ValidatedBodyContext<typeof createDepositBodySchema>
) {
  const body = c.req.valid("json");

  try {
    const idempotencyKey = requireIdempotencyKey(c, "Private Channels deposits");
    const context = await resolveDepositCreateContext(c, {
      walletId: body.walletId,
      recipient: body.recipient,
    });
    const projectRpc = await loadPrivateChannelProjectRpcClient(c);

    // Auth-enabled instances JWT-gate the gateway baseline read.
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      userId: context.auth.userId,
    });

    const userId = context.actor.user_id;
    if (!userId) {
      throw unauthorized("Private Channel deposits require a user session.");
    }

    const deposit = await createChannelDeposit(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      userId,
      wallet: context.wallet,
      amount: body.amount,
      mint: body.mint,
      recipient: context.recipient,
      idempotencyKey,
      gatewayAuth,
      projectRpc,
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
