import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { createSigningService } from "@/services/domain/signing.service";
import { type AppContext, getPreferredWalletForConfig, resolveActor } from "../context";
import type { CustodyConfigResponse, CustodyConfigsResponse } from "../schemas";

export const getConfig = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId");

  const signingService = createSigningService(c.env);
  const config = await signingService.getConfiguration(actor.organizationId, projectId);

  if (!config) {
    throw new AppError("NOT_FOUND", "No wallet signing configuration found for this organization");
  }

  const wallet = await getPreferredWalletForConfig(getDb(c.env), config.id, config.defaultWalletId);
  if (!wallet) {
    throw new AppError("INTERNAL_ERROR", "Active provider is missing an active wallet");
  }

  const response: CustodyConfigResponse = {
    config: {
      id: config.id,
      organizationId: config.organizationId,
      projectId: config.projectId,
      provider: config.provider,
      publicKey: wallet.publicKey,
      defaultWalletId: config.defaultWalletId,
      status: config.status,
      createdAt: config.createdAt,
    },
  };

  return success(c, response);
};

export const getConfigs = async (c: AppContext) => {
  const actor = resolveActor(c);
  const projectId = c.req.query("projectId") ?? undefined;
  const signingService = createSigningService(c.env);
  const { configs, defaultConfigId } = await signingService.getConfigurations(
    actor.organizationId,
    projectId
  );

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

  const availableConfigIds = new Set(resolvedConfigs.map((config) => config.id));
  const effectiveDefaultConfigId =
    defaultConfigId && availableConfigIds.has(defaultConfigId) ? defaultConfigId : null;

  const response: CustodyConfigsResponse = {
    configs: resolvedConfigs.map((config) => ({
      ...config,
      isDefault: effectiveDefaultConfigId === config.id,
    })),
    defaultConfigId: effectiveDefaultConfigId,
  };

  return success(c, response);
};
