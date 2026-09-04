import { mapPrivateChannelInstanceRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { resolveScope, resolveWalletAddress } from "@/routes/payments/wallets";
import { getChannelBalance, mapPrivateChannelError } from "@/services/private-channels";
import { resolveGatewayAuth } from "@/services/private-channels/auth/gateway-auth";
import type { AppContext } from "../context";
import {
  getPrivateChannelInstanceRepository,
  loadPrivateChannelProjectRpcClient,
} from "../context";
import { balanceQuerySchema } from "../schemas";

/**
 * GET /balance — read an owner's channel token balance through the gateway.
 * `owner` accepts a `walletId`, a wallet public key, or a raw Solana address
 * (resolved via the shared wallet helpers); `mint` defaults to the instance
 * cluster's USDC mint. The connection is the project's ACTIVE persisted instance.
 * Feature-gated (router middleware) + `payments:read`.
 *
 * TODO(visibility): balance is per (wallet, mint) at the SPC layer and shared across
 * channels, so the read primitive is correct but this endpoint is UNDER-GATED: any
 * project member with `payments:read` can read ANY `owner`'s balance. The intended
 * rule is no visibility beyond your own channels — a caller may read a balance only
 * when they are a project ADMIN, the wallet's own user, or share an active channel
 * with it, which `private_channel_memberships` and
 * `private_channel_verified_wallets` can answer. Adding the gate likely means moving
 * balance under a channel-scoped route. The UI should also say: "Balances belong to
 * your wallet; if you're in multiple channels, they all show the same amount."
 */
export async function getPrivateChannelBalance(c: AppContext) {
  const parsed = balanceQuerySchema.safeParse({
    owner: c.req.query("owner"),
    mint: c.req.query("mint"),
  });
  if (!parsed.success) {
    throw badRequest("owner query parameter is required");
  }

  try {
    const auth = getAuth(c);
    const projectId = requireProjectId(c);

    const row = await getPrivateChannelInstanceRepository(c).getActiveByProject({
      organizationId: auth.organizationId,
      projectId,
    });
    if (!row) {
      throw notFound("Active private channel instance");
    }
    const instance = mapPrivateChannelInstanceRow(row);

    const { wallets } = await resolveScope(c);
    const owner = resolveWalletAddress(wallets, parsed.data.owner, "owner", auth, ["wallets:read"]);

    // Auth-enabled instances JWT-gate balance reads; mint the caller's SPC session.
    const gatewayAuth = await resolveGatewayAuth(c.env, {
      instance,
      organizationId: auth.organizationId,
      projectId,
      userId: auth.userId,
    });
    const projectRpc = await loadPrivateChannelProjectRpcClient(c);

    const balance = await getChannelBalance(c.env, {
      instance,
      owner,
      mint: parsed.data.mint,
      auth: gatewayAuth,
      cluster: projectRpc.cluster,
    });
    return success(c, balance);
  } catch (error) {
    throw mapPrivateChannelError(error);
  }
}
