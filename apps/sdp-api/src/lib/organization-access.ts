import { organizationStatusMayAuthenticate } from "@sdp/types/organizations";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import { parsePostgresJson } from "@/db/postgres-utils";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import { getClientIp } from "@/lib/client-ip";
import { AppError } from "@/lib/errors";
import { isClientIpAllowed } from "@/lib/ip-allowlist";
import { resolveApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";
import type { Env } from "@/types/env";

/**
 * The one uncached organization read every authenticated request makes, and
 * what it decides (HOO-1955; APE-387, APE-564):
 *
 * - the organization is still `active` — a deleted or suspended organization
 *   stops authenticating on its next request, whatever a cache still says;
 * - for an API key, the key's own row is still usable (active, not expired,
 *   not past its rotation deadline), read in the same statement by primary key;
 * - for an API key, its wallet scope and bindings (HOO-2048), so routes check
 *   wallets against this request's read and never re-read them;
 * - the request's origin passes `settings.allowedIpAddresses`.
 *
 * Caches (the API-key KV entry, its reconciliation sweep) only make rejection
 * cheaper: they can never keep a revoked credential authenticated, because
 * this read runs on every request. Deliberately uncached for the same reason —
 * a cache would keep the previous answer for its TTL after a revocation or an
 * allowlist change.
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

/** What the uncached API-key read decided: the settings and the key's wallet scope. */
export interface ApiKeyOrganizationAccess {
  settings: string | null;
  walletAuthorization: ReturnType<typeof resolveApiKeyWalletAuthorization>;
}

/**
 * Organization access for an API key, with the key's own live row in the same
 * statement: the organization must be `active` and the key's row must exist
 * and be usable, whatever the cached entry says. A cached key with no row is
 * refused like an unknown key; nothing falls back to the organization's word.
 *
 * The same statement reads the key's wallet bindings (HOO-2048), each with the
 * custody wallets it could name and their status, so the request's wallet scope is never
 * the cache's: a key narrowed from all wallets to selected ones, or a binding
 * removed, takes effect on the key's next request. One round trip; routes
 * check wallets against this snapshot and do not re-read bindings.
 */
export async function enforceApiKeyOrganizationAccess(
  c: Context<{ Bindings: Env }>,
  organizationId: string,
  apiKeyId: string
): Promise<ApiKeyOrganizationAccess> {
  const row = await getDb(c.env)
    .prepare(
      `SELECT o.status AS organization_status, o.settings,
              ak.status, ak.expires_at, ak.rotation_deadline,
              ak.signing_wallet_id, wb.wallet_bindings
         FROM organizations o
         LEFT JOIN api_keys ak ON ak.id = ? AND ak.organization_id = o.id
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
        WHERE o.id = ?`
    )
    .bind(apiKeyId, organizationId)
    .first<
      {
        organization_status: string;
        settings: string | null;
        wallet_bindings: unknown;
      } & (
        | (ApiKeyLifecycleColumns & { signing_wallet_id: string | null })
        | {
            status: null;
            expires_at: null;
            rotation_deadline: null;
            signing_wallet_id: null;
          }
      )
    >();

  if (!row || !organizationStatusMayAuthenticate(row.organization_status)) {
    throw new AppError("REVOKED_API_KEY");
  }
  // The organization row comes back either way, so a missing key row is told
  // apart from an inactive organization (which refuses as revoked, above).
  if (row.status === null) {
    throw new AppError("INVALID_API_KEY", "Invalid API key");
  }
  const refusal = apiKeyRowRefusal(row, Date.now());
  if (refusal === "revoked") {
    throw new AppError("REVOKED_API_KEY");
  }
  if (refusal === "expired") {
    throw new AppError("EXPIRED_API_KEY");
  }
  enforceIpAllowlist(c, row.settings);
  return {
    settings: row.settings,
    walletAuthorization: resolveApiKeyWalletAuthorization(
      walletBindingCandidatesSchema.parse(parsePostgresJson<unknown>(row.wallet_bindings)),
      row.signing_wallet_id
    ),
  };
}
