import type {
  EarnButtonConfiguration,
  EarnButtonConfigurationResponse,
  PublicEarnButtonConfigurationResponse,
} from "@sdp/types";
import { isVaultDirectDepositEnabled } from "@sdp/types/provider-access";
import type { EarnButtonConfigurationRow } from "@/db/repositories";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getEarnRepository, resolveSdpEnvironment } from "../context";
import {
  earnButtonConfigurationPublicParamsSchema,
  type earnButtonConfigurationSchema,
} from "../schemas";
import { assertVaultDepositAdmissible } from "./admission";
import { parseParams } from "./shared";
import { isHiddenStrategy, requireEarnStrategy } from "./strategies";

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
  // the exact gate sequence `POST /vault-deposits` runs — shared, not copied
  // (handlers/admission.ts) — after resolving the row through the same
  // visibility policy the catalogue reads apply.
  const strategy = await requireEarnStrategy(c, body.strategyId);
  await assertVaultDepositAdmissible(c, strategy);

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

  // The catalogue's visibility policy binds this read too — an unauthenticated
  // detail route that drifted from the list route would leak a hidden row by
  // id (routes/earn/CLAUDE.md). A strategy that is hidden, delisted (the sync's
  // delete pass; 0068 has no FK on purpose), or no longer active is reported as
  // unavailable with its display metadata withheld, so the handoff page renders
  // an honest stale state instead of a polished snippet the deposit route
  // would refuse.
  const strategy = await repo.getStrategyById(row.strategy_id);
  const strategyAvailable =
    strategy !== null && !isHiddenStrategy(strategy) && strategy.status === "active";
  const response: PublicEarnButtonConfigurationResponse = {
    configuration: {
      strategyId: row.strategy_id,
      strategyName: strategyAvailable ? strategy.name : null,
      provider: strategyAvailable ? strategy.provider : null,
      style: row.style,
      accentColor: row.accent_color,
      strategyAvailable,
    },
  };
  c.header("Cache-Control", "no-store");
  return success(c, response);
}
