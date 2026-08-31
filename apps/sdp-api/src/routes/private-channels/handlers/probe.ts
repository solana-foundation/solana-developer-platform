import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { verifyInstanceConnection } from "@/services/private-channels";
import { loadPrivateChannelProjectRpcClient } from "../context";
import type { probeConnectionSchema } from "../schemas";

// Same probe the Connect handler runs internally — `probe.ok === true` here
// means Connect will not fail on the probe step.
export async function probePrivateChannelConnection(
  c: ValidatedBodyContext<typeof probeConnectionSchema>
) {
  const body = c.req.valid("json");
  const projectRpc = await loadPrivateChannelProjectRpcClient(c);
  const deployment =
    body.escrowProgramId && body.escrowInstanceAddr
      ? {
          escrowProgramId: body.escrowProgramId,
          escrowInstanceAddr: body.escrowInstanceAddr,
        }
      : undefined;
  return success(
    c,
    await verifyInstanceConnection({
      gatewayUrl: body.gatewayUrl,
      authUrl: body.authUrl,
      probeRpc: () => projectRpc.probe(deployment),
    })
  );
}
