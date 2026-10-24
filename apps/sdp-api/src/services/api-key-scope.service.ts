import {
  type Action,
  isActionInReleaseChannel,
  isApiKeyGrantableAction,
  organizationRoleMayPerform,
} from "@sdp/types/actions";
import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import {
  isModuleInReleaseChannel,
  resolveSdpReleaseChannel,
  type SdpRampProviderMaturity,
  type SdpReleaseChannel,
} from "@sdp/types/release-channels";
import type { OrganizationRole } from "@sdp/types/roles";
import type { Context } from "hono";
import type { DatabaseClient } from "@/db/client";
import { AppError, badRequest } from "@/lib/errors";
import type { ApiKeySigningWalletScope } from "@/services/api-key.service";
import type { Env } from "@/types/env";

/**
 * A signed-in person may grant a key only actions an API key may hold, and
 * only actions they hold themselves. Only people manage keys
 * (`requireHumanSession`), so the actor is never itself a key.
 */
export function assertGrantableApiKeyGrants(
  actorRole: OrganizationRole,
  requestedGrants: readonly Action[]
): void {
  const forbiddenForKeys = requestedGrants.filter((grant) => !isApiKeyGrantableAction(grant));
  if (forbiddenForKeys.length > 0) {
    throw new AppError("BAD_REQUEST", `API keys cannot hold: ${forbiddenForKeys.join(", ")}`, {
      actions: forbiddenForKeys,
    });
  }
  const beyondActor = requestedGrants.filter(
    (grant) => !organizationRoleMayPerform(actorRole, grant)
  );
  if (beyondActor.length > 0) {
    throw new AppError(
      "INSUFFICIENT_PERMISSIONS",
      `Cannot grant an API key actions you do not hold: ${beyondActor.join(", ")}`,
      { actions: beyondActor }
    );
  }
}

/** The deployment's release channel, which bounds the grants a key may be given. */
export interface ApiKeyGrantChannel {
  releaseChannel: SdpReleaseChannel;
  rampProviderMaturity: SdpRampProviderMaturity;
}

/** The request's deployment channel, read where the grants are decided. */
export function requestApiKeyGrantChannel(c: Context<{ Bindings: Env }>): ApiKeyGrantChannel {
  return {
    releaseChannel: resolveSdpReleaseChannel(c.env.SDP_RELEASE_CHANNEL),
    rampProviderMaturity: c.get("rampProviderMaturity"),
  };
}

/**
 * A key may be given only actions whose module this deployment's release
 * channel runs, the same set the dashboard offers and the public OpenAPI
 * document's grant enum lists. Create and update refuse the rest with a 400
 * naming them; a key that already stores one (granted before a channel
 * change) keeps it through rotation.
 */
export function assertApiKeyGrantsInReleaseChannel(
  channel: ApiKeyGrantChannel,
  requestedGrants: readonly Action[]
): void {
  const outside = requestedGrants.filter(
    (grant) =>
      !isActionInReleaseChannel(grant, (module) =>
        isModuleInReleaseChannel(channel.releaseChannel, module, channel.rampProviderMaturity)
      )
  );
  if (outside.length > 0) {
    throw new AppError(
      "BAD_REQUEST",
      `Grants outside this deployment's ${channel.releaseChannel} release channel: ${outside.join(", ")}`,
      { actions: outside }
    );
  }
}

/**
 * The wallet scope a create or update asks for (HOO-2099). `all` lists no
 * wallets; `selected` lists exactly `walletIds` (none: the key signs
 * nothing). An update that names wallets must
 * name the scope too, so a list is never applied to an `all` key by accident.
 */
export function parseRequestedWalletScope(input: {
  walletScope: ApiKeyWalletScope | undefined;
  walletIds: readonly string[] | undefined;
}): { scope: ApiKeyWalletScope; walletIds: readonly string[] } | undefined {
  if (input.walletScope === undefined) {
    if (input.walletIds !== undefined) {
      throw badRequest("walletScope is required when updating walletIds");
    }
    return undefined;
  }
  if (input.walletScope === "all") {
    if (input.walletIds !== undefined) {
      throw badRequest("walletScope 'all' cannot be combined with walletIds");
    }
    return { scope: "all", walletIds: [] };
  }
  return { scope: "selected", walletIds: input.walletIds ?? [] };
}

/**
 * Check that every id names a custody wallet of this project (config- or
 * connection-owned), by its immutable row id (APE-390), and return the scope
 * to store. Status is not checked here: the signing waist refuses an inactive
 * wallet, and an edit must be able to keep listing one.
 */
export async function resolveSigningWalletsInProject(
  db: DatabaseClient,
  scope: { organizationId: string; projectId: string },
  requested: { scope: ApiKeyWalletScope; walletIds: readonly string[] }
): Promise<ApiKeySigningWalletScope> {
  if (requested.scope === "all") {
    return { scope: "all" };
  }
  if (requested.walletIds.length === 0) {
    return { scope: "selected", custodyWalletIds: [] };
  }
  const rows = await db.queryMany<{ id: string }>(
    `SELECT w.id
       FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
      WHERE w.id = ANY(?::text[])
        AND ((cfg.organization_id = ? AND cfg.project_id = ?)
          OR (conn.organization_id = ? AND conn.project_id = ?))`,
    [
      [...requested.walletIds],
      scope.organizationId,
      scope.projectId,
      scope.organizationId,
      scope.projectId,
    ]
  );
  const found = new Set(rows.map((row) => row.id));
  const unknown = requested.walletIds.filter((id) => !found.has(id));
  if (unknown.length > 0) {
    throw badRequest(`Unknown wallet ids for this project: ${unknown.join(", ")}`, {
      walletIds: unknown,
    });
  }
  return { scope: "selected", custodyWalletIds: [...requested.walletIds] };
}
