import { mapPrivateChannelInstanceRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { readPrivateChannelTokenEligibility } from "@/services/private-channels/mint";
import { loadProjectRpcClient } from "@/services/private-channels/project-rpc";
import type { AppContext } from "../context";
import { getPrivateChannelInstanceRepository } from "../context";

/** GET /tokens — SDP registry tokens combined with the instance's on-chain allowlist. */
export async function listPrivateChannelTokenEligibility(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const row = await getPrivateChannelInstanceRepository(c).getActiveByProject({
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) throw notFound("Active private channel instance");

  const tokens = await readPrivateChannelTokenEligibility(
    mapPrivateChannelInstanceRow(row),
    loadProjectRpcClient()
  );
  return success(c, { tokens });
}
