import { getDb } from "@/db/client";
import { getAuth, requireProjectId, walletAccessAllows } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import { assertCallerWalletInScope } from "@/lib/money-admission";
import type { AuthorizeInput } from "@/middleware/authorize";
import { findProjectOperationalWallet } from "@/routes/custody/handlers/wallets";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import type { AppContext } from "./context";

/**
 * Access checks for custody wallet routes (HOO-1918, ADR 0009). They run
 * before the Idempotency-Key step, so a replay passes exactly these checks.
 * They check the credential's access, never a wallet's status: a wallet
 * deactivated or deleted since a request ran still lets that request be
 * answered. Whether a wallet is usable now is the handler's call. They are
 * project-scoped: whether a key may sign with a wallet is the custody
 * signer's decision (HOO-2099).
 */

function body<T>(input: AuthorizeInput): T {
  // SAFETY: each check is mounted after validateBody with the route's schema.
  return input.body as T;
}

const walletNotFound = () => new AppError("NOT_FOUND", "Custody wallet not found");

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

/** Wallet create: any named connection belongs to the project. */
export async function authorizeCreateWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  const auth = getAuth(c);
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
  const notFound = () => new AppError("NOT_FOUND", "Wallet not found");
  await assertCustodyWalletInProject(c, walletId, true, notFound);
  // A selected key reaches only the wallets it lists (HOO-2099), as on the
  // wallet detail read: the record the handler updates is checked here.
  const wallet = await findProjectOperationalWallet(c, walletId, true);
  if (wallet && !walletAccessAllows(getAuth(c).walletAccess, wallet.id)) {
    throw notFound();
  }
}

/** Wallet delete: the wallet the body names. */
export async function authorizeDeleteWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  const walletId = body<{ walletId: string }>(input).walletId;
  await assertCustodyWalletInProject(c, walletId, false, walletNotFound);
  // A selected key reaches only the wallets it lists (HOO-2099): the record
  // the handler would deactivate is checked here, before the key is claimed.
  const auth = getAuth(c);
  const owned = await new CustodyRuntimeTargets(
    getDb(c.env),
    c.env,
    new Map()
  ).findOwnedWalletForMutation({
    organizationId: auth.organizationId,
    projectId: requireProjectId(c),
    walletId,
  });
  if (owned && !walletAccessAllows(auth.walletAccess, owned.id)) {
    throw walletNotFound();
  }
}

/**
 * Signer check: the wallet the body names, in the caller's project, with the
 * route's own 400 for an unknown one, which is never stored. Whether the
 * caller may sign with it is the custody signer's decision (HOO-2099).
 */
export async function authorizeSignerCheck(c: AppContext, input: AuthorizeInput): Promise<void> {
  const walletId = body<{ walletId: string }>(input).walletId;
  await assertCustodyWalletInProject(c, walletId, false, () =>
    badRequest("Custody wallet not found")
  );
  // The scope is checked against the exact record the handler signs with: a
  // provider wallet id can be on several records. The custody signer refuses
  // it too; refusing here keeps the refused check out of the Idempotency-Key
  // store, so a retry after a scope fix runs. No operational record: the
  // handler answers that.
  const wallet = await findProjectOperationalWallet(c, walletId);
  if (wallet) {
    assertCallerWalletInScope(getAuth(c).walletAccess, wallet.id);
  }
}
