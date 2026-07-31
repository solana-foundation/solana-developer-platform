import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { verifyInstanceConnection } from "@/services/private-channels";
import type { AppContext } from "../context";
import { probeConnectionSchema } from "../schemas";

// Same probe the Connect handler runs internally — `probe.ok === true` here
// means Connect will not fail on the probe step.
export async function probePrivateChannelConnection(c: AppContext) {
  const body = await c.req.json();
  const parsed = probeConnectionSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("gatewayUrl and chainRpcUrl are required");
  }
  return success(c, await verifyInstanceConnection(parsed.data));
}
