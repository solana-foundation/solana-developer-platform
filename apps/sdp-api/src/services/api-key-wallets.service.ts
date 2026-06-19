import type { Permission } from "@sdp/types";
import type { PreparedStatement } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";

export interface ApiKeyWalletBinding {
  walletId: string;
  permissions: Permission[];
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

function safeParsePermissions(raw: string): Permission[] | null {
  const parsed = parsePostgresJsonOr<unknown>(raw, null);
  if (!Array.isArray(parsed)) {
    return null;
  }

  return parsed.filter((entry): entry is Permission => typeof entry === "string");
}
