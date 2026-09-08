import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { toProbeResultDto, verifyInstanceConnection } from "@/services/private-channels";
import { loadPrivateChannelProjectRpcClient } from "../context";
import type { probeConnectionSchema } from "../schemas";

// Same probe the Connect handler runs internally — `probe.ok === true` here
// means Connect will not fail on the probe step.
//
// The two SPC URLs come straight from the request, so they reach the network
// only through the guarded probe transport, and only the bounded DTO comes back:
// relaying the engine result would hand the caller whatever body the gateway it
// nominated chose to return.
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
  const probe = await verifyInstanceConnection(c.env, {
    gatewayUrl: body.gatewayUrl,
    authUrl: body.authUrl,
    probeRpc: () => projectRpc.probe(deployment),
  });
  return success(c, toProbeResultDto(probe));
}
