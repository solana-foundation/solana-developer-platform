import { requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createSigningService } from "@/services/domain/signing.service";
import { type AppContext, resolveActor } from "../context";
import type { CustodyConfigsResponse } from "../schemas";

export const getConfigs = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const signingService = createSigningService(c.env, getRequestTenantScope(c));
  const configs = await signingService.getConfigurations(actor.organizationId, projectId);

  const response: CustodyConfigsResponse = {
    configs: configs.map((config) => ({
      id: config.id,
      organizationId: config.organizationId,
      projectId: config.projectId,
      provider: config.provider,
      status: config.status,
      createdAt: config.createdAt,
    })),
  };

  return success(c, response);
};
