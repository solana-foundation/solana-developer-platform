import {
  type ApiKeyRole,
  type ApiKeyWalletBinding,
  type ApiKeyWalletScope,
  getPermissionsForApiKeyRole,
  hasAllPermissions,
  hasAnyPermission,
  type Permission,
} from "@sdp/types";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, badRequest, conflict } from "@/lib/errors";
import {
  type ExactApiKeyWalletBinding,
  loadApiKeyWalletAuthorization,
  normalizeApiKeyWalletPermissions,
} from "@/services/api-key-wallets.service";

type WalletBindingInput = {
  walletId: string;
  permissions?: Permission[];
};

type WalletBindingPatchInput = {
  signingWalletId?: string | null;
  signingWalletIds?: string[] | null;
  walletBindings?: WalletBindingInput[] | null;
};

export type ParsedWalletBindingPatch = {
  touched: boolean;
  defaultSigningWalletId: string | null;
  bindings: ApiKeyWalletBinding[];
};

type WalletScopeInput = WalletBindingPatchInput & {
  walletScope?: ApiKeyWalletScope;
  provisionWallet?: boolean;
  connectionId?: string;
};

function trimWalletId(walletId: string): string {
  const normalized = walletId.trim();
  if (!normalized) {
    throw badRequest("Wallet IDs must be non-empty strings");
  }
  return normalized;
}

function normalizeBindings(auth: ApiKeyContext) {
  return auth.walletBindings.map((binding) => ({
    walletId: binding.walletId,
    custodyWalletId: binding.custodyWalletId,
    permissions: binding.permissions.length > 0 ? binding.permissions : (["*"] as Permission[]),
  }));
}

function hasSelectedWalletScope(auth: ApiKeyContext): boolean {
  if (auth.authType !== "api_key") {
    return false;
  }
  if (auth.walletScope) {
    return auth.walletScope === "selected";
  }
  return auth.walletBindings.length > 0 || auth.signingWalletId !== null;
}

function getBindingForWallet(auth: ApiKeyContext, walletId: string) {
  const bindings = normalizeBindings(auth);
  if (bindings.length === 0) {
    return null;
  }

  return bindings.find((entry) => entry.walletId === walletId) ?? null;
}

function hasBindingPermission(
  binding: ApiKeyWalletBinding,
  requiredPermissions: Permission[]
): boolean {
  if (requiredPermissions.length === 0) {
    return true;
  }

  if (binding.permissions.includes("*")) {
    return true;
  }

  return requiredPermissions.every((permission) => binding.permissions.includes(permission));
}

export function parseWalletBindingPatch(input: WalletBindingPatchInput): ParsedWalletBindingPatch {
  const touched =
    input.signingWalletId !== undefined ||
    input.signingWalletIds !== undefined ||
    input.walletBindings !== undefined;

  const clearAllRequested =
    input.signingWalletId === null ||
    input.signingWalletIds === null ||
    input.walletBindings === null;

  if (clearAllRequested) {
    if (
      typeof input.signingWalletId === "string" ||
      Array.isArray(input.signingWalletIds) ||
      Array.isArray(input.walletBindings)
    ) {
      throw new AppError(
        "BAD_REQUEST",
        "Cannot combine null wallet binding fields with non-null wallet binding values"
      );
    }

    return {
      touched,
      defaultSigningWalletId: null,
      bindings: [],
    };
  }

  const bindingsByWalletId = new Map<string, ApiKeyWalletBinding>();
  const orderedWalletIds: string[] = [];

  const upsertBinding = (walletId: string, permissions?: Permission[]) => {
    const normalizedWalletId = trimWalletId(walletId);
    if (!bindingsByWalletId.has(normalizedWalletId)) {
      orderedWalletIds.push(normalizedWalletId);
      bindingsByWalletId.set(normalizedWalletId, {
        walletId: normalizedWalletId,
        permissions: permissions ? normalizeApiKeyWalletPermissions(permissions) : ["*"],
      });
      return;
    }

    if (permissions) {
      bindingsByWalletId.set(normalizedWalletId, {
        walletId: normalizedWalletId,
        permissions: normalizeApiKeyWalletPermissions(permissions),
      });
    }
  };

  for (const binding of input.walletBindings ?? []) {
    upsertBinding(binding.walletId, binding.permissions);
  }

  for (const walletId of input.signingWalletIds ?? []) {
    upsertBinding(walletId);
  }

  if (typeof input.signingWalletId === "string") {
    upsertBinding(input.signingWalletId);
  }

  const bindings = orderedWalletIds.map((walletId) => {
    const binding = bindingsByWalletId.get(walletId);
    if (!binding) {
      throw new AppError("INTERNAL_ERROR", "Failed to resolve API key wallet binding");
    }
    return binding;
  });

  const defaultSigningWalletId =
    typeof input.signingWalletId === "string"
      ? trimWalletId(input.signingWalletId)
      : (bindings[0]?.walletId ?? null);

  return {
    touched,
    defaultSigningWalletId,
    bindings,
  };
}

export function resolveCreateWalletScope(input: WalletScopeInput): {
  walletScope: ApiKeyWalletScope;
  defaultSigningWalletId: string | null;
  bindings: ApiKeyWalletBinding[];
} {
  const walletScope = input.walletScope;
  if (!walletScope) {
    throw badRequest("walletScope is required");
  }
  if (input.connectionId && !input.provisionWallet) {
    throw badRequest("connectionId requires provisionWallet");
  }

  const walletBindingPatch = parseWalletBindingPatch(input);

  if (walletScope === "all") {
    if (input.provisionWallet) {
      throw new AppError(
        "BAD_REQUEST",
        "walletScope 'all' cannot be combined with provisionWallet"
      );
    }
    if (walletBindingPatch.touched) {
      throw new AppError(
        "BAD_REQUEST",
        "walletScope 'all' cannot be combined with signingWalletId, signingWalletIds, or walletBindings"
      );
    }

    return {
      walletScope,
      defaultSigningWalletId: null,
      bindings: [],
    };
  }

  if (!input.provisionWallet && walletBindingPatch.bindings.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "walletScope 'selected' requires wallet bindings or provisionWallet"
    );
  }

  return {
    walletScope,
    defaultSigningWalletId: walletBindingPatch.defaultSigningWalletId,
    bindings: walletBindingPatch.bindings,
  };
}

export function resolveUpdateWalletScope(input: WalletScopeInput): {
  walletScope: ApiKeyWalletScope | undefined;
  defaultSigningWalletId: string | null;
  bindings: ApiKeyWalletBinding[];
  touched: boolean;
} {
  const walletBindingPatch = parseWalletBindingPatch(input);
  const walletScope = input.walletScope;

  if (walletScope === undefined) {
    if (walletBindingPatch.touched) {
      throw new AppError(
        "BAD_REQUEST",
        "walletScope is required when updating API key wallet access"
      );
    }

    return {
      walletScope,
      defaultSigningWalletId: walletBindingPatch.defaultSigningWalletId,
      bindings: walletBindingPatch.bindings,
      touched: false,
    };
  }

  if (walletScope === "all") {
    if (input.provisionWallet) {
      throw new AppError(
        "BAD_REQUEST",
        "walletScope 'all' cannot be combined with provisionWallet"
      );
    }
    if (walletBindingPatch.touched) {
      throw new AppError(
        "BAD_REQUEST",
        "walletScope 'all' cannot be combined with signingWalletId, signingWalletIds, or walletBindings"
      );
    }

    return {
      walletScope,
      defaultSigningWalletId: null,
      bindings: [],
      touched: true,
    };
  }

  if (input.provisionWallet) {
    throw badRequest("provisionWallet is only supported during API key creation");
  }

  if (!walletBindingPatch.touched || walletBindingPatch.bindings.length === 0) {
    throw new AppError(
      "BAD_REQUEST",
      "walletScope 'selected' requires signingWalletId, signingWalletIds, or walletBindings"
    );
  }

  return {
    walletScope,
    defaultSigningWalletId: walletBindingPatch.defaultSigningWalletId,
    bindings: walletBindingPatch.bindings,
    touched: true,
  };
}

export async function resolveWalletBindingsInScope(
  db: DatabaseClient,
  organizationId: string,
  keyProjectId: string,
  bindings: ApiKeyWalletBinding[]
): Promise<ExactApiKeyWalletBinding[]> {
  if (bindings.length === 0) {
    return [];
  }

  const walletIds = bindings.map((binding) => binding.walletId);
  const placeholders = walletIds.map(() => "?").join(", ");

  const rows = await db
    .prepare(
      `SELECT w.id AS custody_wallet_id, w.wallet_id
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ?
         AND c.status = 'active'
         AND w.status = 'active'
         AND (c.project_id IS NULL OR c.project_id = ?)
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
    .bind(organizationId, keyProjectId, ...walletIds, organizationId, keyProjectId, ...walletIds)
    .all<{ custody_wallet_id: string; wallet_id: string }>();

  const matchesByWalletId = new Map<string, string[]>();
  for (const row of rows.results ?? []) {
    const matches = matchesByWalletId.get(row.wallet_id) ?? [];
    matches.push(row.custody_wallet_id);
    matchesByWalletId.set(row.wallet_id, matches);
  }

  const missingWalletIds = walletIds.filter(
    (walletId) => (matchesByWalletId.get(walletId)?.length ?? 0) === 0
  );
  if (missingWalletIds.length > 0) {
    throw badRequest(`Unknown signing wallet IDs: ${missingWalletIds.join(", ")}`);
  }

  for (const [walletId, matches] of matchesByWalletId) {
    if (matches.length > 1) {
      throw conflict(`Custody wallet ownership is ambiguous for walletId: ${walletId}`);
    }
  }

  return bindings.map((binding) => ({
    ...binding,
    custodyWalletId: matchesByWalletId.get(binding.walletId)?.[0] as string,
  }));
}

export function assertGrantableApiKeyPermissions(
  actorPermissions: Permission[],
  resolvedRole: ApiKeyRole,
  requestedPermissions: Permission[] | null | undefined
): void {
  if (hasAnyPermission(actorPermissions, ["org:admin"])) {
    return;
  }

  const effectivePermissions =
    requestedPermissions == null ? getPermissionsForApiKeyRole(resolvedRole) : requestedPermissions;

  if (!hasAllPermissions(actorPermissions, effectivePermissions)) {
    throw new AppError(
      "INSUFFICIENT_PERMISSIONS",
      "Cannot grant an API key more permissions than you hold"
    );
  }
}

/**
 * Reject wallet-scoped API keys outright. For scope-level custody mutations
 * (create wallet, initialize/switch provider) where the result is by
 * definition outside the key's bindings.
 */
export function assertApiKeyNotWalletScoped(auth: ApiKeyContext, action: string): void {
  if (auth.authType !== "api_key") {
    return;
  }

  if (!hasSelectedWalletScope(auth)) {
    return;
  }

  throw new AppError("FORBIDDEN", `Wallet-scoped API keys cannot ${action}`);
}

export function assertApiKeyWalletAccess(
  auth: ApiKeyContext,
  walletId: string,
  requiredPermissions: Permission[] = []
): void {
  if (auth.authType !== "api_key") {
    return;
  }

  if (!hasSelectedWalletScope(auth)) {
    return;
  }

  const binding = getBindingForWallet(auth, walletId);
  if (!binding) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }

  if (!hasBindingPermission(binding, requiredPermissions)) {
    throw new AppError(
      "FORBIDDEN",
      `API key does not include required wallet permissions: ${requiredPermissions.join(", ")}`
    );
  }
}

export function resolveApiKeySigningWalletId(
  auth: ApiKeyContext,
  requestedWalletId: string | null | undefined,
  requiredPermissions: Permission[] = []
): string | null {
  if (requestedWalletId) {
    assertApiKeyWalletAccess(auth, requestedWalletId, requiredPermissions);
    return requestedWalletId;
  }

  const bindings = normalizeBindings(auth);
  const preferredBinding = auth.signingWalletId
    ? bindings.find((binding) => binding.walletId === auth.signingWalletId)
    : null;
  if (preferredBinding) {
    assertApiKeyWalletAccess(auth, preferredBinding.walletId, requiredPermissions);
    return preferredBinding.walletId;
  }

  if (auth.signingWalletId) {
    throw new AppError("FORBIDDEN", "API key has no usable wallet bindings");
  }

  if (bindings.length === 1) {
    assertApiKeyWalletAccess(auth, bindings[0].walletId, requiredPermissions);
    return bindings[0].walletId;
  }

  if (bindings.length > 1 && auth.authType === "api_key") {
    throw new AppError(
      "BAD_REQUEST",
      "Multiple signing wallets are bound to this API key. Specify a walletId."
    );
  }

  if (hasSelectedWalletScope(auth)) {
    throw new AppError("FORBIDDEN", "API key has no usable wallet bindings");
  }

  return null;
}

export function getAllowedApiKeyWalletIds(auth: ApiKeyContext): string[] | null {
  if (auth.authType !== "api_key") {
    return null;
  }

  if (!hasSelectedWalletScope(auth)) {
    return null;
  }

  return normalizeBindings(auth).map((binding) => binding.walletId);
}

export function getAllowedApiKeyWalletIdsForPermissions(
  auth: ApiKeyContext,
  requiredPermissions: Permission[] = []
): string[] | null {
  if (auth.authType !== "api_key") {
    return null;
  }

  if (!hasSelectedWalletScope(auth)) {
    return null;
  }

  return normalizeBindings(auth)
    .filter((binding) => hasBindingPermission(binding, requiredPermissions))
    .map((binding) => binding.walletId);
}

export function getAllowedApiKeyWalletAuthorizationForPermissions(
  auth: ApiKeyContext,
  requiredPermissions: Permission[] = []
): { custodyWalletIds: string[]; providerWalletIds: string[] } | null {
  if (auth.authType !== "api_key" || !hasSelectedWalletScope(auth)) {
    return null;
  }

  const bindings = normalizeBindings(auth).filter((binding) =>
    hasBindingPermission(binding, requiredPermissions)
  );
  const custodyWalletIds = bindings.map((binding) => {
    if (typeof binding.custodyWalletId !== "string" || binding.custodyWalletId.length === 0) {
      throw new AppError("INTERNAL_ERROR", "API key wallet authorization scope is inconsistent");
    }
    return binding.custodyWalletId;
  });

  return {
    custodyWalletIds,
    providerWalletIds: bindings.map((binding) => binding.walletId),
  };
}

export function filterApiKeyWallets<T extends { walletId: string }>(
  auth: ApiKeyContext,
  wallets: T[],
  requiredPermissions: Permission[] = []
): T[] {
  if (auth.authType !== "api_key") {
    return wallets;
  }

  if (!hasSelectedWalletScope(auth)) {
    return wallets;
  }

  return wallets.filter((wallet) => {
    const binding = getBindingForWallet(auth, wallet.walletId);
    if (!binding) {
      return false;
    }
    return hasBindingPermission(binding, requiredPermissions);
  });
}

export function getAllowedApiKeyCustodyWalletIdsForPermissions(
  auth: ApiKeyContext,
  requiredPermissions: Permission[] = []
): string[] | null {
  if (auth.authType !== "api_key" || !hasSelectedWalletScope(auth)) {
    return null;
  }

  return normalizeBindings(auth)
    .filter(
      (binding) =>
        typeof binding.custodyWalletId === "string" &&
        binding.custodyWalletId.length > 0 &&
        hasBindingPermission(binding, requiredPermissions)
    )
    .map((binding) => binding.custodyWalletId as string);
}

export function resolveApiKeyCustodyWalletId(
  auth: ApiKeyContext,
  requestedWalletId: string | null | undefined,
  requiredPermissions: Permission[] = [],
  allowRecordIdAlias = false
): string | null {
  if (auth.authType !== "api_key" || !hasSelectedWalletScope(auth)) {
    return null;
  }

  const bindings = normalizeBindings(auth).filter(
    (binding) => typeof binding.custodyWalletId === "string" && binding.custodyWalletId.length > 0
  );
  const binding = requestedWalletId
    ? bindings.find(
        (entry) =>
          entry.walletId === requestedWalletId ||
          (allowRecordIdAlias && entry.custodyWalletId === requestedWalletId)
      )
    : auth.signingWalletId
      ? bindings.find((entry) => entry.walletId === auth.signingWalletId)
      : bindings.length === 1
        ? bindings[0]
        : null;

  if (!binding) {
    if (!requestedWalletId && bindings.length > 1) {
      throw badRequest("Multiple signing wallets are bound to this API key. Specify a walletId.");
    }
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }
  if (!hasBindingPermission(binding, requiredPermissions)) {
    throw new AppError(
      "FORBIDDEN",
      `API key does not include required wallet permissions: ${requiredPermissions.join(", ")}`
    );
  }
  return binding.custodyWalletId as string;
}

/**
 * Re-read selected endpoint wallet permissions before new exact-wallet work.
 * The request auth context may contain a one-hour KV snapshot; duplicate
 * Provider wallet IDs must become deny-only immediately for Payments writes.
 */
export async function assertFreshApiKeyCustodyWalletAccess(
  db: DatabaseClient,
  auth: ApiKeyContext,
  custodyWalletId: string,
  requiredPermissions: Permission[] = []
): Promise<void> {
  if (auth.authType !== "api_key" || !hasSelectedWalletScope(auth)) {
    return;
  }
  if (!auth.projectId) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }

  const currentKey = await db
    .prepare(
      `SELECT signing_wallet_id
       FROM api_keys
       WHERE id = ?
         AND organization_id = ?
         AND project_id = ?`
    )
    .bind(auth.apiKeyId, auth.organizationId, auth.projectId)
    .first<{ signing_wallet_id: string | null }>();
  if (!currentKey) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }

  const freshAuthorization = await loadApiKeyWalletAuthorization(
    db,
    auth.apiKeyId,
    auth.organizationId,
    auth.projectId,
    currentKey.signing_wallet_id
  );
  const allowedCustodyWalletIds = getAllowedApiKeyCustodyWalletIdsForPermissions(
    { ...auth, ...freshAuthorization },
    requiredPermissions
  );
  if (!allowedCustodyWalletIds?.includes(custodyWalletId)) {
    throw new AppError("FORBIDDEN", "API key is not authorized for the requested wallet");
  }
}
