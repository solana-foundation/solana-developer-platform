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
  if (!permissions || permissions.length === 0) {
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

function safeParsePermissions(raw: unknown): Permission[] | null {
  const parsed = parsePostgresJsonOr<unknown>(raw, null);
  if (!Array.isArray(parsed)) {
    return null;
  }

  return parsed.filter((entry): entry is Permission => typeof entry === "string");
}
