import { getDb } from "@/db";
import { success } from "@/lib/response";
import { getCustodySetupStatus } from "@/services/custody-setup-status.service";
import { type AppContext, resolveActor } from "../context";

export const getSetupStatus = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.get("projectId");

  const status = await getCustodySetupStatus(getDb(c.env), actor.organizationId, projectId);

  return success(c, status);
};
