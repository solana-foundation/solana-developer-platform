import type { ApiKeyWalletScope } from "@sdp/types/api-keys";
import type { Permission } from "@sdp/types/permissions";
import type { PreparedStatement } from "@/db/client";
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
  status: string;
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

/** A custody wallet a binding could name, with its status. */
export interface ApiKeyWalletCandidate {
  id: string;
  status: string;
}

/**
 * A binding row with every custody wallet it could name: wallets of any status
 * under an active custody config or connection in the key's organization and
 * project, matched by provider wallet id.
 */
export interface ApiKeyWalletBindingCandidates {
  wallet_id: string;
  permissions: unknown;
  candidates: ApiKeyWalletCandidate[];
}

/**
 * The one custody wallet a binding names: the single active candidate, or,
 * when none is active, the single candidate of any status. Wallet status is
 * state, not access (HOO-1918): a binding still reaches a deactivated wallet,
 * so a replay passes the same check as the original, and the handler's runtime
 * admission refuses moving money from it. Anything else is ambiguous.
 */
function resolveBindingCandidate(candidates: ApiKeyWalletCandidate[]): string | null {
  const active = candidates.filter((candidate) => candidate.status === "active");
  const pool = active.length > 0 ? active : candidates;
  return pool.length === 1 ? pool[0].id : null;
}

/**
 * Resolve binding rows to exact custody wallets. A binding that names no
 * wallet, or is ambiguous, hydrates as deny-only: the key stays selected
 * scope, with no usable wallet there. Pure, because authentication runs it on
 * every request; the cache fill reports unresolved bindings to operators.
 */
export function resolveApiKeyWalletAuthorization(
  rows: ApiKeyWalletBindingCandidates[],
  preferredSigningWalletId: string | null
) {
  return hydrateApiKeyWalletAuthorization(
    rows.map(
      (row): ApiKeyWalletPermissionRow => ({
        wallet_id: row.wallet_id,
        permissions: row.permissions,
        custody_wallet_id: resolveBindingCandidate(row.candidates),
      })
    ),
    preferredSigningWalletId
  );
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
      `SELECT w.id AS custody_wallet_id, w.wallet_id, w.status
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.status = 'active'
         AND w.wallet_id IN (${placeholders})

       UNION ALL

       SELECT w.id AS custody_wallet_id, w.wallet_id, w.status
       FROM custody_wallets w
       JOIN custody_connections c ON c.id = w.custody_connection_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.status = 'active'
         AND w.wallet_id IN (${placeholders})`
    )
    .bind(organizationId, projectId, ...walletIds, organizationId, projectId, ...walletIds)
    .all<CustodyWalletCandidateRow>();

  const candidatesByWalletId = new Map<string, ApiKeyWalletCandidate[]>();
  for (const candidate of candidates.results ?? []) {
    const matches = candidatesByWalletId.get(candidate.wallet_id) ?? [];
    matches.push({ id: candidate.custody_wallet_id, status: candidate.status });
    candidatesByWalletId.set(candidate.wallet_id, matches);
  }

  const rows = permissionRows.map((row) => ({
    wallet_id: row.wallet_id,
    permissions: row.permissions,
    candidates: candidatesByWalletId.get(row.wallet_id) ?? [],
  }));
  // Once per cache fill, not per request: the binding hydrates as deny-only, so
  // the key silently loses that wallet.
  for (const row of rows) {
    if (resolveBindingCandidate(row.candidates) === null) {
      getLogger().warn(
        {
          apiKeyId,
          organizationId,
          projectId,
          walletId: row.wallet_id,
          candidateCount: row.candidates.length,
        },
        "api_key_wallet_binding_unresolved"
      );
    }
  }
  return resolveApiKeyWalletAuthorization(rows, preferredSigningWalletId);
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
  bindings: ApiKeyWalletBinding[]
): Promise<void> {
  const statements: PreparedStatement[] = [
    db.prepare("DELETE FROM api_key_wallet_permissions WHERE api_key_id = ?").bind(apiKeyId),
  ];

  for (const binding of bindings) {
    statements.push(
      db
        .prepare(
          `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES (?, ?, ?, ?)`
        )
        .bind(
          `akw_${crypto.randomUUID()}`,
          apiKeyId,
          binding.walletId,
          JSON.stringify(normalizeApiKeyWalletPermissions(binding.permissions))
        )
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
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
        SELECT
         'akw_' || md5(random()::text || clock_timestamp()::text),
         ?,
         wallet_id,
         permissions
       FROM api_key_wallet_permissions
       WHERE api_key_id = ?`
    )
    .bind(targetApiKeyId, sourceApiKeyId)
    .run();
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
