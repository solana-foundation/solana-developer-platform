import type { ApiKeyWalletScope, Permission } from "@sdp/types";
import type { PreparedStatement } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import { getLogger } from "@/runtime/logger";

export interface ApiKeyWalletBinding {
  walletId: string;
  permissions: Permission[];
}

export interface ExactApiKeyWalletBinding extends ApiKeyWalletBinding {
  custodyWalletId: string;
}

export interface ApiKeyWalletBindingForKey extends ApiKeyWalletBinding {
  apiKeyId: string;
}

export interface ApiKeyWalletPermissionRow {
  wallet_id: string;
  custody_wallet_id: string | null;
  permissions: unknown;
}

interface CustodyWalletCandidateRow {
  custody_wallet_id: string;
  wallet_id: string;
}

export const DEFAULT_API_KEY_WALLET_PERMISSIONS: Permission[] = ["*"];

export function normalizeApiKeyWalletPermissions(permissions?: Permission[] | null): Permission[] {
  // Only an ABSENT permissions list means "unrestricted". An explicitly empty
  // array is an intent to grant nothing and must never widen to the wildcard
  // default — that would turn an attempt to restrict a key into full access.
  if (permissions == null) {
    return [...DEFAULT_API_KEY_WALLET_PERMISSIONS];
  }

  const deduped = Array.from(new Set(permissions));
  if (deduped.includes("*")) {
    return ["*"];
  }

  return deduped;
}

export function hydrateApiKeyWalletAuthorization(
  permissionRows: ApiKeyWalletPermissionRow[],
  preferredSigningWalletId: string | null
): {
  walletScope: ApiKeyWalletScope;
  signingWalletId: string | null;
  signingWalletIds: string[];
  walletBindings: ExactApiKeyWalletBinding[];
} {
  const walletBindings = permissionRows.flatMap((row) =>
    row.custody_wallet_id
      ? [
          {
            walletId: row.wallet_id,
            custodyWalletId: row.custody_wallet_id,
            permissions: normalizeApiKeyWalletPermissions(safeParsePermissions(row.permissions)),
          },
        ]
      : []
  );
  const signingWalletIds = walletBindings.map((binding) => binding.walletId);

  return {
    walletScope:
      permissionRows.length > 0 || preferredSigningWalletId !== null ? "selected" : "all",
    signingWalletId: preferredSigningWalletId ?? signingWalletIds[0] ?? null,
    signingWalletIds,
    walletBindings,
  };
}

export async function loadApiKeyWalletAuthorization(
  db: DatabaseClient,
  apiKeyId: string,
  organizationId: string,
  projectId: string,
  preferredSigningWalletId: string | null
) {
  const permissionResult = await db
    .prepare(
      `SELECT wallet_id, permissions
       FROM api_key_wallet_permissions
       WHERE api_key_id = ?
       ORDER BY created_at ASC`
    )
    .bind(apiKeyId)
    .all<Omit<ApiKeyWalletPermissionRow, "custody_wallet_id">>();

  const permissionRows = permissionResult.results ?? [];
  if (permissionRows.length === 0 && preferredSigningWalletId) {
    permissionRows.push({ wallet_id: preferredSigningWalletId, permissions: ["*"] });
  }
  if (permissionRows.length === 0) {
    return hydrateApiKeyWalletAuthorization([], preferredSigningWalletId);
  }

  const walletIds = permissionRows.map((row) => row.wallet_id);
  const placeholders = walletIds.map(() => "?").join(", ");
  const candidates = await db
    .prepare(
      `SELECT w.id AS custody_wallet_id, w.wallet_id
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ?
         AND (c.project_id IS NULL OR c.project_id = ?)
         AND c.status = 'active'
         AND w.status = 'active'
         AND w.wallet_id IN (${placeholders})

       UNION ALL

       SELECT w.id AS custody_wallet_id, w.wallet_id
       FROM custody_wallets w
       JOIN custody_connections c ON c.id = w.custody_connection_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.status = 'active'
         AND w.status = 'active'
         AND w.wallet_id IN (${placeholders})`
    )
    .bind(organizationId, projectId, ...walletIds, organizationId, projectId, ...walletIds)
    .all<CustodyWalletCandidateRow>();

  const candidatesByWalletId = new Map<string, string[]>();
  for (const candidate of candidates.results ?? []) {
    const matches = candidatesByWalletId.get(candidate.wallet_id) ?? [];
    matches.push(candidate.custody_wallet_id);
    candidatesByWalletId.set(candidate.wallet_id, matches);
  }

  const resolvedRows = permissionRows.map((row): ApiKeyWalletPermissionRow => {
    const matches = candidatesByWalletId.get(row.wallet_id) ?? [];
    if (matches.length !== 1) {
      // The binding hydrates as deny-only (selected scope, no usable wallet),
      // so the key silently loses access; surface it for operators.
      getLogger().warn(
        {
          apiKeyId,
          organizationId,
          projectId,
          walletId: row.wallet_id,
          candidateCount: matches.length,
        },
        "api_key_wallet_binding_unresolved"
      );
    }
    return {
      ...row,
      custody_wallet_id: matches.length === 1 ? matches[0] : null,
    };
  });

  return hydrateApiKeyWalletAuthorization(resolvedRows, preferredSigningWalletId);
}

export async function listApiKeyWalletBindings(
  db: DatabaseClient,
  apiKeyId: string
): Promise<ApiKeyWalletBinding[]> {
  const result = await db
    .prepare(
      `SELECT wallet_id, permissions
       FROM api_key_wallet_permissions
       WHERE api_key_id = ?
       ORDER BY created_at ASC`
    )
    .bind(apiKeyId)
    .all<{ wallet_id: string; permissions: string }>();

  return (result.results ?? []).map((row) => ({
    walletId: row.wallet_id,
    permissions: normalizeApiKeyWalletPermissions(safeParsePermissions(row.permissions)),
  }));
}

export async function listApiKeyWalletBindingsForApiKeys(
  db: DatabaseClient,
  apiKeyIds: string[]
): Promise<ApiKeyWalletBindingForKey[]> {
  if (apiKeyIds.length === 0) {
    return [];
  }

  const result = await db
    .prepare(
      `SELECT api_key_id, wallet_id, permissions
       FROM api_key_wallet_permissions
       WHERE api_key_id = ANY(?::text[])
       ORDER BY api_key_id ASC, created_at ASC`
    )
    .bind(apiKeyIds)
    .all<{ api_key_id: string; wallet_id: string; permissions: unknown }>();

  return (result.results ?? []).map((row) => ({
    apiKeyId: row.api_key_id,
    walletId: row.wallet_id,
    permissions: normalizeApiKeyWalletPermissions(safeParsePermissions(row.permissions)),
  }));
}

export async function replaceApiKeyWalletBindings(
  db: DatabaseClient,
  apiKeyId: string,
  bindings: ApiKeyWalletBinding[],
  options: { provisioned?: boolean } = {}
): Promise<void> {
  const statements: PreparedStatement[] = [
    db.prepare("DELETE FROM api_key_wallet_permissions WHERE api_key_id = ?").bind(apiKeyId),
  ];

  for (const binding of bindings) {
    statements.push(
      db
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions, provisioned_binding)
         VALUES (?, ?, ?, ?, ?)`
        )
        .bind(
          `akw_${crypto.randomUUID()}`,
          apiKeyId,
          binding.walletId,
          JSON.stringify(normalizeApiKeyWalletPermissions(binding.permissions)),
          options.provisioned === true
        )
    );
  }

  if (bindings.length > 0) {
    // Consuming a wallet as a key's signing wallet retires its provisioning
    // provenance in the same transaction as the binding: a wallet whose
    // provisioning attempt completed is never re-adopted by a later retry,
    // even after the binding (or the key itself) is gone.
    statements.push(
      db
        .prepare(
          `UPDATE custody_wallets
           SET creation_reason = NULL,
               provisioned_by_api_key_id = NULL,
               provisioned_by_user_id = NULL
           WHERE wallet_id IN (${bindings.map(() => "?").join(", ")})
             AND (creation_reason IS NOT NULL
                  OR provisioned_by_api_key_id IS NOT NULL
                  OR provisioned_by_user_id IS NOT NULL)`
        )
        .bind(...bindings.map((binding) => binding.walletId))
    );
  }

  await db.batch(statements);
}

export async function upsertApiKeyWalletBinding(
  db: DatabaseClient,
  apiKeyId: string,
  binding: ApiKeyWalletBinding
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(api_key_id, wallet_id)
       DO UPDATE SET
         permissions = excluded.permissions,
         updated_at = sdp_iso_now()`
    )
    .bind(
      `akw_${crypto.randomUUID()}`,
      apiKeyId,
      binding.walletId,
      JSON.stringify(normalizeApiKeyWalletPermissions(binding.permissions))
    )
    .run();
}

export async function cloneApiKeyWalletBindings(
  db: DatabaseClient,
  sourceApiKeyId: string,
  targetApiKeyId: string
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions, provisioned_binding)
        SELECT
         'akw_' || md5(random()::text || clock_timestamp()::text),
         ?,
         wallet_id,
         permissions,
         provisioned_binding
       FROM api_key_wallet_permissions
       WHERE api_key_id = ?`
    )
    .bind(targetApiKeyId, sourceApiKeyId)
    .run();
}

/**
 * Whether a failed transaction was rejected by the exclusive-binding guarantee
 * for provisioned wallets (migration 0119): a wallet provisioned for API-key
 * creation can be bound to exactly one key, so two requests that adopted the
 * same still-unbound wallet cannot both commit. The loser surfaces as a 409
 * instead of an opaque storage error.
 */
export function isProvisionedWalletBindingConflict(error: unknown): boolean {
  for (
    let current: unknown = error;
    current != null;
    current = (current as { cause?: unknown }).cause
  ) {
    const candidate = current as { constraint?: unknown; code?: unknown };
    if (
      candidate.constraint === "uq_api_key_wallet_permissions_provisioned_wallet" &&
      candidate.code === "23505"
    ) {
      return true;
    }
  }
  return false;
}

/** Parse an api_key_wallet_permissions.permissions column into a normalized list. */
export function parseApiKeyWalletPermissionsColumn(raw: unknown): Permission[] {
  return normalizeApiKeyWalletPermissions(safeParsePermissions(raw));
}

function safeParsePermissions(raw: unknown): Permission[] | null {
  // Only a genuinely ABSENT value (SQL NULL) may map to null — the
  // historical unrestricted default. A value that exists but cannot be
  // parsed as an array fails CLOSED: conflating corrupt data with absence
  // would widen a broken permissions row into full wallet access.
  if (raw == null) {
    return null;
  }

  const parsed = parsePostgresJsonOr<unknown>(raw, undefined);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is Permission => typeof entry === "string");
}
