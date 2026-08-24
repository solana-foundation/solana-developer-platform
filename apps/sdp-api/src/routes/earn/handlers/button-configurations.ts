import { isEarnProviderId, providerNotConfigured } from "@sdp/earn";
import type {
  EarnButtonConfiguration,
  EarnButtonConfigurationResponse,
  PublicEarnButtonConfigurationResponse,
} from "@sdp/types";
import { earnDepositStyle, isVaultDirectDepositEnabled } from "@sdp/types/provider-access";
import { getDb } from "@/db";
import type { EarnButtonConfigurationRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  assertEarnProviderSurfaced,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnButtonConfigurationPublicParamsSchema,
  type earnButtonConfigurationSchema,
} from "../schemas";
import { assertStrategyDepositable } from "./admission";
import { parseParams } from "./shared";
import { requireEarnStrategy } from "./strategies";

function mapConfiguration(row: EarnButtonConfigurationRow): EarnButtonConfiguration {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    style: row.style,
    accentColor: row.accent_color,
    publicToken: row.public_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getEarnButtonConfiguration(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const row = await getEarnRepository(c).getButtonConfiguration({
    organizationId: auth.organizationId,
    projectId,
  });
  if (!row) throw notFound("Earn button configuration");

  const response: EarnButtonConfigurationResponse = { configuration: mapConfiguration(row) };
  return success(c, response);
}

export async function upsertEarnButtonConfiguration(
  c: ValidatedBodyContext<typeof earnButtonConfigurationSchema>
) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const environment = resolveSdpEnvironment(c);
  const body = c.req.valid("json");

  if (!isVaultDirectDepositEnabled(environment)) {
    throw new AppError(
      "FORBIDDEN",
      "Earn button configuration is unavailable in production because new vault deposits are sandbox-only."
    );
  }

  // The builder is a money-in handoff. Persisting a strategy that the deposit
  // route will refuse would create a polished dead end, so configuration runs
  // the same visibility, execution-model, surfacing, entitlement, credential,
  // status, and cluster gates before it writes anything.
  const strategy = await requireEarnStrategy(c, body.strategyId);
  if (earnDepositStyle(strategy.provider) !== "vault_direct") {
    throw badRequest(
      `${strategy.provider} does not support the vault-deposit integration used by Earn buttons.`
    );
  }
  if (!isEarnProviderId(strategy.provider)) {
    throw providerNotConfigured(
      `Earn provider ${strategy.provider} is not available in this deployment`
    );
  }

  assertEarnProviderSurfaced(strategy.provider);
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    auth.organizationId,
    "earn",
    strategy.provider,
    environment === "sandbox"
  );
  assertStrategyDepositable(strategy, environment);

  const row = await getEarnRepository(c).upsertButtonConfiguration({
    organizationId: auth.organizationId,
    projectId,
    strategyId: strategy.id,
    style: body.style,
    accentColor: body.accentColor,
    actorId: auth.id,
  });
  const response: EarnButtonConfigurationResponse = { configuration: mapConfiguration(row) };
  return success(c, response);
}

/** Public read by unguessable handoff token. Never returns tenant or auth data. */
export async function getPublicEarnButtonConfiguration(c: AppContext) {
  const { publicToken } = parseParams(c, earnButtonConfigurationPublicParamsSchema);
  const repo = getEarnRepository(c);
  const row = await repo.getButtonConfigurationByPublicToken(publicToken);
  if (!row) throw notFound("Earn button integration");

  const strategy = await repo.getStrategyById(row.strategy_id);
  const response: PublicEarnButtonConfigurationResponse = {
    configuration: {
      strategyId: row.strategy_id,
      strategyName: strategy?.name ?? null,
      provider: strategy?.provider ?? null,
      style: row.style,
      accentColor: row.accent_color,
    },
  };
  c.header("Cache-Control", "no-store");
  return success(c, response);
}
