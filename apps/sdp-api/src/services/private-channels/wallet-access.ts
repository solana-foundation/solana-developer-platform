import {
  type ApiKeyRole,
  getPermissionsForApiKeyRole,
  hasAllPermissions,
  PERMISSIONS,
  type Permission,
} from "@sdp/types";
import { z } from "zod";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import type { ApiKeyContext } from "@/lib/auth";
import {
  AppError,
  conflict,
  forbidden,
  internalError,
  providerUnavailable,
  walletNotFound,
} from "@/lib/errors";
import {
  assertFreshApiKeyActive,
  assertFreshApiKeyCustodyWalletAccess,
} from "@/services/api-key-scope.service";
import { loadApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

const explicitPermissionsSchema = z.array(z.enum(PERMISSIONS));

/** Refresh coarse access before authorizing a specific operation or wallet. */
export async function refreshPrivateChannelAuth(
  env: Env,
  auth: ApiKeyContext,
  projectId: string
): Promise<ApiKeyContext> {
  if (auth.authType !== "api_key") return auth;
  const db = getDb(env);
  await assertFreshApiKeyActive(db, auth);
  const current = await db.queryOne<{
    role: ApiKeyRole;
    permissions: string | null;
    signing_wallet_id: string | null;
  }>(
    "SELECT role, permissions, signing_wallet_id FROM api_keys WHERE id = ? AND organization_id = ? AND project_id = ?",
    [auth.apiKeyId, auth.organizationId, projectId]
  );
  if (!current) throw forbidden("API key is not authorized for this project");
  let permissions: Permission[];
  try {
    // SQL NULL inherits the current role; an explicit empty array grants nothing.
    permissions =
      current.permissions === null
        ? getPermissionsForApiKeyRole(current.role)
        : explicitPermissionsSchema.parse(parsePostgresJson<unknown>(current.permissions));
  } catch {
    throw internalError("Stored API key permissions are invalid");
  }
  return {
    ...auth,
    role: current.role,
    permissions,
    signingWalletId: current.signing_wallet_id,
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
    includeAllProviders: true,
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
  if (current.authType === "api_key") {
    const bindings = await loadApiKeyWalletAuthorization(
      getDb(env),
      current.apiKeyId,
      current.organizationId,
      projectId,
      current.signingWalletId
    );
    await assertFreshApiKeyCustodyWalletAccess(getDb(env), { ...current, ...bindings }, wallet.id, [
      "payments:write",
    ]);
  }
  return wallet;
}

/** Admit and prepare the same exact wallet before a new SPC session or intent. */
export async function createPrivateChannelSigner(
  env: Env,
  organizationId: string,
  projectId: string,
  wallet: CustodyWallet
) {
  await createSigningService(env).admitRuntimeExecution(organizationId, projectId, wallet.id);
  try {
    return await createOrgSignerForCustodyWallet(env, organizationId, projectId, wallet.id);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw providerUnavailable("The source custody wallet is not currently signable.");
  }
}
