import {
  type AllowedOperation,
  upgradeStoredAllowedOperations,
} from "@sdp/types/allowed-operations";
import type { ApiKeyEnvironment, RateLimitTier } from "@sdp/types/api-keys";
import { organizationStatusMayAuthenticate } from "@sdp/types/organizations";
import type { ApiKeyRole, Permission } from "@sdp/types/permissions";
import { projectStatusMayAuthenticate } from "@sdp/types/projects";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import { parseOptionalPostgresJson, parsePostgresJson } from "@/db/postgres-utils";
import { parseStoredApiKeyPermissions } from "@/lib/api-key-permissions";
import { refuseTerminally } from "@/lib/api-key-refusal-cache";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import {
  resolveApiKeyWalletAuthorization,
  warnUnresolvedApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import type { Env } from "@/types/env";

/**
 * The one uncached organization read every authenticated request makes, and
 * what it decides (HOO-1955; APE-387, APE-564):
 *
 * - the organization is still `active` — a deleted or suspended organization
 *   stops authenticating on its next request, whatever a cache still says;
 * - for an API key, the key's own row, read in the same statement by key hash:
 *   it is still usable (active, not expired, not past its rotation deadline),
 *   its project is active, and every authorization field (role, permissions,
 *   Allowed Operations, IP restriction, rate-limit tier, project, environment)
 *   comes from it;
 * - for an API key, its wallet scope and bindings (HOO-2048), so routes check
 *   wallets against this request's read and never re-read them;
 * - the request's origin passes `settings.allowedIpAddresses`.
 *
 * Deliberately uncached: a cache would keep the previous answer for its TTL
 * after a revocation, a permission change or an allowlist change.
 *
 * Returns the raw settings it read, so authentication records the
 * organization's entitlements from the same read (APE-351).
 */

/**
 * Returned as `unknown` on purpose: pre-validation values can be any shape,
 * and {@link isClientIpAllowed} already fails closed on anything unrecognized —
 * that decision belongs in one place.
 */
function readAllowedIpAddresses(settings: string | null): unknown {
  if (!settings) {
    return null;
  }

  const parsed = parsePostgresJson<{ allowedIpAddresses?: unknown } | null>(settings);
  return parsed?.allowedIpAddresses ?? null;
}

/**
 * Apply `settings.allowedIpAddresses` to the current request. Runs on every
 * authenticated path — a restriction only one of three doors honors is not a
 * restriction; an API key's own `allowedIps` intersects on top.
 *
 * A malformed restriction fails closed. The settings column is JSON the API
 * writes itself, so a blob that does not parse is a bug: it throws, and the
 * request fails loudly with a 500.
 */
function enforceIpAllowlist(c: Context<{ Bindings: Env }>, settings: string | null): void {
  if (!isClientIpAllowed(getClientIp(c), readAllowedIpAddresses(settings))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this organization");
  }
}

/** The refusal a session-based door (Clerk) gives a non-active organization. */
export function organizationNotActive(): AppError {
  return new AppError("UNAUTHORIZED", "Organization is not active");
}

/**
 * The session doors' uncached organization read: the organization must exist
 * and be `active`. Returns its raw settings.
 */
export async function readActiveOrganizationSettings(
  env: Env,
  organizationId: string
): Promise<string | null> {
  const row = await getDb(env)
    .prepare("SELECT status, settings FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ status: string; settings: string | null }>();

  if (!row || !organizationStatusMayAuthenticate(row.status)) {
    throw organizationNotActive();
  }
  return row.settings;
}

/**
 * Organization access for a session-based door (Clerk): the organization must
 * exist and be `active`, and the origin must pass its allowlist. Call it before
 * the door writes anything, so a refused request leaves no state behind.
 */
export async function enforceOrganizationAccess(
  c: Context<{ Bindings: Env }>,
  organizationId: string
): Promise<string | null> {
  const settings = await readActiveOrganizationSettings(c.env, organizationId);
  enforceIpAllowlist(c, settings);
  return settings;
}

/**
 * The `wallet_bindings` aggregate. `permissions` is the raw column, which
 * {@link resolveApiKeyWalletAuthorization} parses and fails closed on.
 */
const walletBindingCandidatesSchema = z.array(
  z.object({
    wallet_id: z.string(),
    permissions: z.unknown(),
    candidates: z.array(z.object({ id: z.string(), status: z.string() })),
  })
);

/** The `api_keys` row and its joins, as the authoritative read returns them. */
type ApiKeyAuthorizationRow = ApiKeyLifecycleColumns & {
  id: string;
  organization_id: string;
  project_id: string;
  role: ApiKeyRole;
  permissions: string | null;
  allowed_ips: string | null;
  allowed_operations: string | null;
  rate_limit_tier: RateLimitTier;
  signing_wallet_id: string | null;
  environment: ApiKeyEnvironment;
  project_status: string;
  organization_status: string;
  settings: string | null;
  wallet_bindings: unknown;
};

/** Everything an API key may do on this request, all from one read. */
export interface ApiKeyAuthorization {
  id: string;
  organizationId: string;
  projectId: string;
  role: ApiKeyRole;
  permissions: Permission[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  /** Null when the key places no restriction (no list, or an empty one). */
  allowedOperations: AllowedOperation[] | null;
  /** The organization's raw settings, for its entitlements. */
  settings: string | null;
  walletAuthorization: ReturnType<typeof resolveApiKeyWalletAuthorization>;
}

/**
 * Authorize an API key from its live rows: one uncached statement driven by
 * `api_keys.key_hash` (UNIQUE) that returns the key's every authorization
 * field, its project's status and environment, its organization's status and
 * settings, and its wallet bindings (HOO-2048), each with the custody wallets
 * it could name and their status. Nothing is cached, so a revocation, a
 * permission or Allowed Operations change, an IP restriction, an archived
 * project or a narrowed wallet scope applies on the key's next request.
 *
 * Refuses, in order: an unknown key (INVALID_API_KEY); an inactive
 * organization or project (REVOKED_API_KEY); a revoked, expired or
 * past-its-rotation-deadline key (REVOKED_API_KEY / EXPIRED_API_KEY); an
 * origin outside the key's `allowed_ips`, then the organization's allowlist
 * (FORBIDDEN). The filters stay out of SQL so each refusal keeps its code.
 */
export async function authorizeApiKey(
  c: Context<{ Bindings: Env }>,
  keyHash: string
): Promise<ApiKeyAuthorization> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT ak.id, ak.organization_id, ak.project_id, ak.role, ak.permissions,
              ak.allowed_ips, ak.allowed_operations, ak.rate_limit_tier,
              ak.status, ak.expires_at, ak.rotation_deadline, ak.signing_wallet_id,
              p.environment, p.status AS project_status,
              o.status AS organization_status, o.settings,
              wb.wallet_bindings
         FROM api_keys ak
         JOIN organizations o ON o.id = ak.organization_id
         JOIN projects p ON p.id = ak.project_id AND p.organization_id = ak.organization_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(
                    json_agg(
                      json_build_object(
                        'wallet_id', b.wallet_id,
                        'permissions', b.permissions,
                        'candidates', (
                          SELECT COALESCE(
                                   json_agg(json_build_object('id', m.id, 'status', m.status) ORDER BY m.id),
                                   '[]'::json
                                 )
                            FROM (
                              SELECT w.id, w.status
                                FROM custody_wallets w
                                JOIN custody_configs cc ON cc.id = w.custody_config_id
                               WHERE cc.organization_id = o.id
                                 AND cc.project_id = ak.project_id
                                 AND cc.status = 'active'
                                 AND w.wallet_id = b.wallet_id
                              UNION ALL
                              SELECT w.id, w.status
                                FROM custody_wallets w
                                JOIN custody_connections cn ON cn.id = w.custody_connection_id
                               WHERE cn.organization_id = o.id
                                 AND cn.project_id = ak.project_id
                                 AND cn.status = 'active'
                                 AND w.wallet_id = b.wallet_id
                            ) m
                        )
                      )
                      ORDER BY b.created_at
                    ),
                    '[]'::json
                  ) AS wallet_bindings
             FROM (
               SELECT p.wallet_id, p.permissions, p.created_at
                 FROM api_key_wallet_permissions p
                WHERE p.api_key_id = ak.id
               UNION ALL
               -- A legacy signing-wallet key carries no binding rows and holds
               -- full access to its signing wallet.
               SELECT ak.signing_wallet_id, '["*"]', ''
                WHERE ak.signing_wallet_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM api_key_wallet_permissions p WHERE p.api_key_id = ak.id
                  )
             ) b
         ) wb ON true
        WHERE ak.key_hash = ?`
    )
    .bind(keyHash)
    .first<ApiKeyAuthorizationRow>();

  if (!row) {
    throw refuseTerminally(keyHash, "INVALID_API_KEY");
  }
  // Organization and project status before the key's own: a key created or
  // rotated after an organization deletion enumerated its keys is covered by
  // neither that deletion's revocation nor anything else.
  if (
    !organizationStatusMayAuthenticate(row.organization_status) ||
    !projectStatusMayAuthenticate(row.project_status)
  ) {
    throw new AppError("REVOKED_API_KEY");
  }
  const refusal = apiKeyRowRefusal(row, Date.now());
  // A dead key never comes back, so its refusal is remembered; the
  // organization and project refusals above can lift and are not.
  if (refusal === "revoked") {
    throw refuseTerminally(keyHash, "REVOKED_API_KEY");
  }
  if (refusal === "expired") {
    throw refuseTerminally(keyHash, "EXPIRED_API_KEY");
  }
  if (!isClientIpAllowed(getClientIp(c), parseOptionalPostgresJson<unknown>(row.allowed_ips))) {
    throw new AppError("FORBIDDEN", "Request origin is not allowed for this API key");
  }
  enforceIpAllowlist(c, row.settings);

  const walletBindings = walletBindingCandidatesSchema.parse(
    parsePostgresJson<unknown>(row.wallet_bindings)
  );
  warnUnresolvedApiKeyWalletBindings(walletBindings, {
    apiKeyId: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
  });
  const storedAllowedOperations = parseOptionalPostgresJson<string[]>(row.allowed_operations);
  const allowedOperations = storedAllowedOperations
    ? upgradeStoredAllowedOperations(storedAllowedOperations)
    : [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    role: row.role,
    permissions: parseStoredApiKeyPermissions(row.role, row.permissions),
    environment: row.environment,
    rateLimitTier: row.rate_limit_tier,
    allowedOperations: allowedOperations.length > 0 ? allowedOperations : null,
    settings: row.settings,
    walletAuthorization: resolveApiKeyWalletAuthorization(walletBindings, row.signing_wallet_id),
  };
}
