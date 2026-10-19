import { getDb } from "@/db/client";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import {
  assertApiKeyNotWalletScoped,
  isApiKeyWalletAccessDenied,
  resolveApiKeyCustodyWalletId,
  resolveApiKeySigningWalletId,
} from "@/services/api-key-scope.service";
import type { AppContext } from "./context";

/**
 * Access checks for custody wallet routes (HOO-1918, ADR 0009). They run
 * before the Idempotency-Key step, so a replay passes exactly these checks.
 * They check the credential's access, never a wallet's status: a wallet
 * deactivated or deleted since a request ran still lets that request be
 * answered. Whether a wallet is usable now is the handler's call.
 */

function body<T>(input: AuthorizeInput): T {
  // SAFETY: each check is mounted after validateBody with the route's schema.
  return input.body as T;
}

const walletNotFound = () => new AppError("NOT_FOUND", "Custody wallet not found");

type WalletPermissions = Parameters<typeof resolveApiKeyCustodyWalletId>[2];

/**
 * A custody wallet the request names by provider wallet id (or custody wallet
 * id): the key's bindings as authentication read them on this request
 * (HOO-2048), deactivated wallets kept. A denied binding reads as a missing
 * wallet, as the handlers answer.
 */
function authorizeCustodyWalletBinding(
  c: AppContext,
  walletId: string,
  requiredPermissions: WalletPermissions,
  notFound: () => AppError
): void {
  try {
    resolveApiKeyCustodyWalletId(getAuth(c), walletId, requiredPermissions, true);
  } catch (error) {
    if (isApiKeyWalletAccessDenied(error)) throw notFound();
    throw error;
  }
}

/**
 * The named wallet belongs to the caller's project, whatever its status or its
 * owner's: checked before the key is claimed, so a wrong id is never stored as
 * a 404. Ambiguity, and whether the wallet is usable, stay in the handler.
 */
async function assertCustodyWalletInProject(
  c: AppContext,
  walletId: string,
  allowRecordIdAlias: boolean,
  notFound: () => AppError
): Promise<void> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const row = await getDb(c.env)
    .prepare(
      `SELECT w.id
         FROM custody_wallets w
         LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
         LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
        WHERE (w.wallet_id = ? OR (?::boolean AND w.id = ?))
          AND ((cfg.organization_id = ? AND cfg.project_id = ?)
            OR (conn.organization_id = ? AND conn.project_id = ?))
        LIMIT 1`
    )
    .bind(
      walletId,
      allowRecordIdAlias,
      walletId,
      auth.organizationId,
      projectId,
      auth.organizationId,
      projectId
    )
    .first<{ id: string }>();
  if (!row) {
    throw notFound();
  }
}

/**
 * A wallet the request names: the credential's binding (a denial reads as
 * "Custody wallet not found"), then the wallet in the project (`notFound`, the
 * handler's own answer for a missing wallet).
 */
async function authorizeCustodyWallet(
  c: AppContext,
  walletId: string,
  requiredPermissions: WalletPermissions,
  options: { allowRecordIdAlias: boolean; notFound: () => AppError }
): Promise<void> {
  authorizeCustodyWalletBinding(c, walletId, requiredPermissions, walletNotFound);
  await assertCustodyWalletInProject(c, walletId, options.allowRecordIdAlias, options.notFound);
}

/** Provider initialize: never a wallet-scoped key (the new wallet is outside its bindings). */
export function authorizeInitializeSigning(c: AppContext): void {
  assertApiKeyNotWalletScoped(getAuth(c), "initialize custody providers");
}

/** Wallet create: never a wallet-scoped key, and any named connection belongs to the project. */
export async function authorizeCreateWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  const auth = getAuth(c);
  assertApiKeyNotWalletScoped(auth, "create custody wallets");
  const { connectionId } = body<{ connectionId?: string }>(input);
  if (connectionId === undefined) return;
  const connection = await getDb(c.env)
    .prepare(
      `SELECT id FROM custody_connections WHERE id = ? AND organization_id = ? AND project_id = ?`
    )
    .bind(connectionId, auth.organizationId, requireProjectId(c))
    .first<{ id: string }>();
  if (!connection) {
    throw new AppError("NOT_FOUND", "Custody connection not found");
  }
}

/** Wallet update: the wallet the path names. */
export async function authorizeUpdateWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  // SAFETY: this route mounts no validateParams (HOO-2046), so params is
  // Hono's c.req.param(), a string record of the path's parameters.
  const walletId = (input.params as { walletId?: string }).walletId?.trim();
  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }
  // The handler resolves the path's id with its record-id alias and answers "Wallet not found".
  return authorizeCustodyWallet(c, walletId, ["wallets:write"], {
    allowRecordIdAlias: true,
    notFound: () => new AppError("NOT_FOUND", "Wallet not found"),
  });
}

/** Wallet delete: the wallet the body names. */
export async function authorizeDeleteWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  return authorizeCustodyWallet(c, body<{ walletId: string }>(input).walletId, ["wallets:write"], {
    allowRecordIdAlias: false,
    notFound: walletNotFound,
  });
}

/** Signer check: the wallet the body names, or the key's own signing wallet. */
export function authorizeSignerCheck(c: AppContext, input: AuthorizeInput): void {
  const auth = getAuth(c);
  const walletId = resolveApiKeySigningWalletId(auth, body<{ walletId?: string }>(input).walletId, [
    "wallets:write",
  ]);
  if (walletId === null) {
    throw badRequest(
      auth.authType === "api_key"
        ? "API key is not bound to a signing wallet"
        : "walletId is required for session or Clerk authentication"
    );
  }
  // An unknown wallet is a 400 here, which is never stored, so the handler resolves it.
  authorizeCustodyWalletBinding(c, walletId, ["wallets:write"], walletNotFound);
}
