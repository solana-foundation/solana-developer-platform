import type { MovementId } from "@sdp/types/movements";
import { type ApiKeyRole, hasAllPermissions } from "@sdp/types/permissions";
import { getDb } from "@/db/client";
import { parseStoredApiKeyPermissions } from "@/lib/api-key-permissions";
import { type ApiKeyLifecycleColumns, apiKeyRowRefusal } from "@/lib/api-key-rotation";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, conflict, forbidden, providerUnavailable, walletNotFound } from "@/lib/errors";
import { assertApiKeyCustodyWalletAccess } from "@/services/api-key-scope.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

/**
 * Refresh the key's role and permissions before authorizing a specific
 * operation or wallet, and its liveness from the same row, so a key revoked
 * between authentication and this read signs nothing. Authentication already
 * read all of it fresh (HOO-2099); this is the deliberate re-check right before
 * a private-channel movement signs, not a cache workaround. Wallet bindings
 * need no re-read: authentication read them fresh for this request.
 */
// TODO(HOO-2099 PR 3): this second read of the key row in one request goes
// when PR 3 replaces the private-channel re-check; it does not re-check the
// organization or project status that authentication does.
export async function refreshPrivateChannelAuth(
  env: Env,
  auth: ApiKeyContext,
  projectId: string
): Promise<ApiKeyContext> {
  if (auth.authType !== "api_key") return auth;
  const current = await getDb(env).queryOne<
    { role: ApiKeyRole; permissions: string | null } & ApiKeyLifecycleColumns
  >(
    `SELECT role, permissions, status, expires_at, rotation_deadline
       FROM api_keys
      WHERE id = ? AND organization_id = ? AND project_id = ?`,
    [auth.apiKeyId, auth.organizationId, projectId]
  );
  if (!current) throw forbidden("API key is not authorized for this project");
  // The predicate request authentication applies: active, not past expiry,
  // not past its rotation grace period.
  if (apiKeyRowRefusal(current, Date.now()) !== null) {
    throw forbidden("API key is no longer active");
  }
  return {
    ...auth,
    role: current.role,
    permissions: parseStoredApiKeyPermissions(current.role, current.permissions),
  };
}

export function listPrivateChannelCustodyWallets(
  env: Env,
  organizationId: string,
  projectId: string
) {
  return new CustodyRuntimeTargets(getDb(env), env, new Map()).listWallets({
    organizationId,
    projectId,
  });
}

export async function resolvePrivateChannelCustodyWallet(
  env: Env,
  auth: ApiKeyContext,
  projectId: string,
  selector: string,
  wallets?: CustodyWallet[],
  allowAddress = false
): Promise<CustodyWallet> {
  const current = await refreshPrivateChannelAuth(env, auth, projectId);
  if (!hasAllPermissions(current.permissions, ["payments:write"])) {
    throw new AppError("INSUFFICIENT_PERMISSIONS", "Required permissions: payments:write");
  }
  const candidates =
    wallets ?? (await listPrivateChannelCustodyWallets(env, auth.organizationId, projectId));
  const matches = candidates.filter(
    (wallet) => wallet.walletId === selector || (allowAddress && wallet.publicKey === selector)
  );
  if (matches.length > 1) throw conflict("Custody wallet ownership is ambiguous");
  const wallet = matches[0];
  if (!wallet) throw walletNotFound();

  // Retained records must not silently disappear into an active replacement.
  const owned = await new CustodyRuntimeTargets(
    getDb(env),
    env,
    new Map()
  ).findOwnedWalletForMutation({
    organizationId: auth.organizationId,
    projectId,
    walletId: selector,
    publicKey: allowAddress ? selector : undefined,
  });
  if (owned?.id !== wallet.id) throw conflict("Custody wallet ownership is ambiguous");
  assertApiKeyCustodyWalletAccess(current, wallet.id, ["payments:write"]);
  return wallet;
}

/** Admit and prepare the same exact wallet before a new SPC session or intent. */
export async function createPrivateChannelSigner(
  env: Env,
  organizationId: string,
  projectId: string,
  wallet: CustodyWallet,
  movement: MovementId
) {
  await createSigningService(env).admitRuntimeExecution(organizationId, projectId, wallet.id);
  try {
    return await createOrgSignerForCustodyWallet(
      env,
      organizationId,
      projectId,
      wallet.id,
      movement
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerUnavailable("The source custody wallet is not currently signable.");
  }
}
