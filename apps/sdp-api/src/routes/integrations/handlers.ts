import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth, requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import { isModuleInChannel, isProjectProviderEntryInChannel } from "@/middleware/require-module";
import { getProjectIntegrations } from "@/services/integrations.service";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

export const getIntegrationsHandler = async (c: AppContext) => {
  const integrations = await getProjectIntegrations(
    c.env,
    getDb(c.env),
    { organizationId: getAuth(c).organizationId, projectId: requireProjectId(c) },
    {
      isProviderInChannel: (entry) => isProjectProviderEntryInChannel(c, entry),
      isModuleInChannel: (module) => isModuleInChannel(c, module),
    }
  );
  return success(c, integrations);
};
