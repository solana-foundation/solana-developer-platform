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
 * every request; {@link warnUnresolvedApiKeyWalletBindings} reports unresolved
 * bindings to operators.
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

/** How long one key's unresolved-binding warning stays quiet once logged. */
export const UNRESOLVED_BINDING_WARNING_INTERVAL_MS = 10 * 60_000;

/** When each key last logged an unresolved-binding warning, in this process. */
const lastUnresolvedBindingWarningAt = new Map<string, number>();
let nextUnresolvedBindingWarningSweepAt = 0;

/**
 * Report each binding that names no single custody wallet: it hydrates as
 * deny-only, so the key silently loses that wallet. Authentication calls it on
 * every request that reads such a binding, so a key logs at most once per
 * {@link UNRESOLVED_BINDING_WARNING_INTERVAL_MS} in each process, however often
 * it is used.
 */
export function warnUnresolvedApiKeyWalletBindings(
  rows: ApiKeyWalletBindingCandidates[],
  key: { apiKeyId: string; organizationId: string; projectId: string },
  now = Date.now()
): void {
  const unresolved = rows.filter((row) => resolveBindingCandidate(row.candidates) === null);
  if (unresolved.length === 0) {
    return;
  }
  sweepUnresolvedBindingWarnings(now);
  const lastWarnedAt = lastUnresolvedBindingWarningAt.get(key.apiKeyId);
  if (lastWarnedAt !== undefined && now - lastWarnedAt < UNRESOLVED_BINDING_WARNING_INTERVAL_MS) {
    return;
  }
  lastUnresolvedBindingWarningAt.set(key.apiKeyId, now);
  for (const row of unresolved) {
    getLogger().warn(
      { ...key, walletId: row.wallet_id, candidateCount: row.candidates.length },
      "api_key_wallet_binding_unresolved"
    );
  }
}

function sweepUnresolvedBindingWarnings(now: number): void {
  if (now < nextUnresolvedBindingWarningSweepAt) {
    return;
  }
  for (const [apiKeyId, warnedAt] of lastUnresolvedBindingWarningAt) {
    if (now - warnedAt >= UNRESOLVED_BINDING_WARNING_INTERVAL_MS) {
      lastUnresolvedBindingWarningAt.delete(apiKeyId);
    }
  }
  nextUnresolvedBindingWarningSweepAt = now + UNRESOLVED_BINDING_WARNING_INTERVAL_MS;
}

/** Forget every key's last warning, so a test starts from a quiet process. */
export function resetUnresolvedBindingWarningsForTesting(): void {
  lastUnresolvedBindingWarningAt.clear();
  nextUnresolvedBindingWarningSweepAt = 0;
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
