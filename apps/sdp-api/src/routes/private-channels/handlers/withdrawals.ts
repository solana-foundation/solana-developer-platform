import { z } from "zod";
import { mapPrivateChannelInstanceRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound, unauthorized, walletNotFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import {
  createChannelWithdrawal,
  getChannelWithdrawal,
  listChannelWithdrawals,
  mapPrivateChannelError,
} from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import { getPrivateChannelInstanceRepository } from "../context";
import { createWithdrawalBodySchema, withdrawalIdParamSchema } from "../schemas";

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
 * POST /withdrawals — burn the custody wallet's channel-chain balance (via the
 * withdraw program) and broadcast it to the gateway; the operator later releases
 * the matching real USDC on devnet to `destination` (defaults to the owner).
 * Feature-gated + `payments:write`. Returns the withdrawal DTO with its current
 * status (submitted/confirmed, or failed with a reason). `settled` (operator's
 * devnet release observed) is detected asynchronously by the oracle.
 */
export async function createPrivateChannelWithdrawal(c: AppContext) {
  const body = await c.req.json().catch(() => null);
  const parsed = createWithdrawalBodySchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid withdrawal request", {
      fieldErrors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  try {
    const { auth, wallets } = await resolveScope(c);
    const userId = auth.userId;
    if (!userId) {
      throw unauthorized("Private Channel withdrawals require a user session.");
    }
    const projectId = requireProjectId(c);
    const instance = await loadActiveInstance(c, auth.organizationId, projectId);

    // Source wallet must be a custody wallet we can sign for (the burn owner).
    const ownerPubkey = resolveWalletAddress(wallets, parsed.data.walletId, "walletId", auth, [
      "wallets:read",
    ]);
    const wallet = wallets.find((w) => w.publicKey === ownerPubkey);
    if (!wallet) {
      throw walletNotFound();
    }

    // Devnet release destination may be another wallet/address; defaults to the owner.
    const destination = parsed.data.destination
      ? resolveWalletAddress(wallets, parsed.data.destination, "destination", auth, [
          "wallets:read",
        ])
      : undefined;

    // Auth-enabled instances JWT-gate the burn broadcast (write) + confirm (read).
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance,
      organizationId: auth.organizationId,
      projectId,
      userId,
    });

    const withdrawal = await createChannelWithdrawal(c.env, {
      instance,
      organizationId: auth.organizationId,
      projectId,
      userId,
      wallet,
      amount: parsed.data.amount,
      mint: parsed.data.mint,
      destination,
      gatewayAuth,
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
