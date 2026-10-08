import { getDb } from "@/db";
import { requireProjectId } from "@/lib/auth";
import { success } from "@/lib/response";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { createSigningService } from "@/services/domain/signing.service";
import { type AppContext, getPreferredWalletForConfig, resolveActor } from "../context";
import type { CustodyConfigsResponse } from "../schemas";

export const getConfigs = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = requireProjectId(c);
  const signingService = createSigningService(c.env, getRequestTenantScope(c));
  const configs = await signingService.getConfigurations(actor.organizationId, projectId);

  const resolvedConfigs = (
    await Promise.all(
      configs.map(async (config) => {
        const wallet = await getPreferredWalletForConfig(
          getDb(c.env),
          config.id,
          config.defaultWalletId
        );
        if (!wallet) {
          return null;
        }

        return {
          id: config.id,
          organizationId: config.organizationId,
          projectId: config.projectId,
          provider: config.provider,
          publicKey: wallet.publicKey,
          defaultWalletId: config.defaultWalletId,
          status: config.status,
          createdAt: config.createdAt,
        };
      })
    )
  ).filter((config): config is NonNullable<typeof config> => config !== null);

  const response: CustodyConfigsResponse = {
    configs: resolvedConfigs,
  };

  return success(c, response);
};
