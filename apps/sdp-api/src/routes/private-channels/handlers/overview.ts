import { PRIVATE_CHANNEL_EVENT_TYPES } from "@sdp/types";
import { mapPrivateChannelInstanceRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { getInstanceOverview } from "@/services/private-channels";
import type { AppContext } from "../context";
import {
  getPrivateChannelInstanceRepository,
  loadPrivateChannelProjectRpcClient,
} from "../context";
import { recordInstanceError } from "../helpers";

// GET /instance/overview — active instance snapshot: gateway health + a few
// cheap Solana reads via the gateway's JSON-RPC passthrough. 404 when no
// active row (client should route the user to /instance).
export async function getPrivateChannelOverview(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);

  const repo = getPrivateChannelInstanceRepository(c);
  const row = await repo.getActiveByProject({
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) {
    throw notFound("Active private channel instance");
  }

  const instance = mapPrivateChannelInstanceRow(row);
  const projectRpc = await loadPrivateChannelProjectRpcClient(c);
  const overview = await getInstanceOverview(instance, projectRpc.rpc);

  const health = overview.gateway.health;
  if (health.status === "unreachable") {
    await recordInstanceError(
      c,
      row,
      PRIVATE_CHANNEL_EVENT_TYPES.ERROR_SPC_UNREACHABLE,
      new Error(health.error),
      {
        payload: { gatewayUrl: instance.gatewayUrl, latencyMs: health.latencyMs },
      }
    );
  }

  return success(c, { instance, overview });
}
