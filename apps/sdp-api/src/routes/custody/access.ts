import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, badRequest } from "@/lib/errors";
import type { AuthorizeInput } from "@/middleware/authorize";
import {
  assertApiKeyNotWalletScoped,
  assertFreshApiKeyCustodyWalletAccess,
  isApiKeyWalletAccessDenied,
  resolveApiKeyCustodyWalletId,
  resolveApiKeySigningWalletId,
} from "@/services/api-key-scope.service";
import type { AppContext } from "./context";

/**
 * Access checks for custody wallet routes (HOO-1918, ADR 0008). They run
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

/**
 * A custody wallet the request names by custody wallet id or provider wallet
 * id: the key's snapshot binding, and that binding read fresh where the handler
 * reads it fresh (`freshness`). Resolving the
 * wallet itself (ownership, ambiguity, whether it is usable) stays in the
 * handler: a stored response is scoped to this project and credential, so only
 * the credential's access can change before a replay.
 */
async function authorizeCustodyWallet(
  c: AppContext,
  walletId: string,
  requiredPermissions: Parameters<typeof resolveApiKeyCustodyWalletId>[2],
  freshness: "snapshot" | "fresh"
): Promise<void> {
  const auth = getAuth(c);
  let custodyWalletId: string | null;
  try {
    custodyWalletId = resolveApiKeyCustodyWalletId(auth, walletId, requiredPermissions, true);
  } catch (error) {
    if (isApiKeyWalletAccessDenied(error)) throw walletNotFound();
    throw error;
  }
  if (custodyWalletId !== null && freshness === "fresh") {
    await assertFreshApiKeyCustodyWalletAccess(
      getDb(c.env),
      auth,
      custodyWalletId,
      requiredPermissions,
      "any"
    );
  }
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
  const walletId = (input.params as { walletId?: string }).walletId?.trim();
  if (!walletId) {
    throw badRequest("Invalid wallet ID");
  }
  return authorizeCustodyWallet(c, walletId, ["wallets:write"], "snapshot");
}

/** Wallet delete: the wallet the body names. */
export async function authorizeDeleteWallet(c: AppContext, input: AuthorizeInput): Promise<void> {
  return authorizeCustodyWallet(
    c,
    body<{ walletId: string }>(input).walletId,
    ["wallets:write"],
    "snapshot"
  );
}

/** Signer check: the wallet the body names, or the key's own signing wallet. */
export async function authorizeSignerCheck(c: AppContext, input: AuthorizeInput): Promise<void> {
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
  return authorizeCustodyWallet(c, walletId, ["wallets:write"], "fresh");
}
