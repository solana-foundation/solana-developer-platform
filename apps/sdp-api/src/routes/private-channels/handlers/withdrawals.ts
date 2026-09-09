import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  createChannelWithdrawal,
  getChannelWithdrawal,
  listChannelWithdrawals,
  mapPrivateChannelError,
} from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import { loadPrivateChannelProjectRpcClient } from "../context";
import { requireIdempotencyKey } from "../helpers";
import { type createWithdrawalBodySchema, withdrawalIdParamSchema } from "../schemas";
import { resolveWithdrawalCreateContext } from "../value-movement-access";

/**
 * POST /withdrawals — burn the custody wallet's channel-chain balance (via the
 * withdraw program) and broadcast it to the gateway; the operator later releases
 * the matching real USDC to `destination` (defaults to the owner). Feature-gated
 * + `payments:write`. Returns the withdrawal DTO with its current status
 * (submitted/confirmed, or failed with a reason). `settled` (operator's release
 * observed) is detected asynchronously by the oracle.
 *
 * Authorization lives entirely in `resolveWithdrawalCreateContext`: the burn
 * owner must be a custody wallet the ACTING member verified on this instance.
 * That check is what stops one project member from burning another's balance and
 * pointing the release at an address of their own — the two halves of the same
 * attack, since `destination` is otherwise free.
 *
 * `Idempotency-Key` is required. A burn cannot be undone, so the reservation is
 * the only thing standing between a retry and a second irreversible burn.
 */
export async function createPrivateChannelWithdrawal(
  c: ValidatedBodyContext<typeof createWithdrawalBodySchema>
) {
  const body = c.req.valid("json");

  try {
    const idempotencyKey = requireIdempotencyKey(c, "Private Channels withdrawals");
    const context = await resolveWithdrawalCreateContext(c, {
      walletId: body.walletId,
      destination: body.destination,
    });
    const projectRpc = await loadPrivateChannelProjectRpcClient(c);

    // Auth-enabled instances JWT-gate the burn broadcast (write) + confirm (read).
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      userId: context.auth.userId,
    });

    const withdrawal = await createChannelWithdrawal(c.env, {
      instance: context.instance,
      organizationId: context.auth.organizationId,
      projectId: context.projectId,
      // Attribution, not authorization — see the deposit handler. `actor.user_id`
      // is null on every principal created since 0073.
      userId: context.auth.userId ?? null,
      wallet: context.wallet,
      amount: body.amount,
      mint: body.mint,
      destination: context.destination,
      idempotencyKey,
      gatewayAuth,
      projectRpc,
    });
    return success(c, withdrawal);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}

/** GET /withdrawals/:id — read one withdrawal for the project. */
export async function getPrivateChannelWithdrawalById(c: AppContext) {
  const parsed = withdrawalIdParamSchema.safeParse({ id: c.req.param("id") });
  if (!parsed.success) {
    throw badRequest("Invalid withdrawal id");
  }

  try {
    const auth = getAuth(c);
    const projectId = requireProjectId(c);
    const withdrawal = await getChannelWithdrawal(c.env, {
      organizationId: auth.organizationId,
      projectId,
      id: parsed.data.id,
    });
    if (!withdrawal) {
      throw notFound("Withdrawal");
    }
    return success(c, withdrawal);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}

/** GET /withdrawals — list the project's withdrawals, newest first. */
export async function listPrivateChannelWithdrawals(c: AppContext) {
  try {
    const auth = getAuth(c);
    const projectId = requireProjectId(c);
    const withdrawals = await listChannelWithdrawals(c.env, {
      organizationId: auth.organizationId,
      projectId,
    });
    return success(c, { withdrawals });
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}
