import type { ApiKeyWalletBinding, ApiKeyWalletScope, Permission } from "@sdp/types";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { normalizeApiKeyWalletPermissions } from "@/services/api-key-wallets.service";

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
};

function trimWalletId(walletId: string): string {
  const normalized = walletId.trim();
  if (!normalized) {
    throw new AppError("BAD_REQUEST", "Wallet IDs must be non-empty strings");
  }
  return normalized;
}

function normalizeBindings(auth: ApiKeyContext): ApiKeyWalletBinding[] {
  if (auth.walletBindings.length > 0) {
    return auth.walletBindings.map((binding) => ({
      walletId: binding.walletId,
      permissions: binding.permissions.length > 0 ? binding.permissions : ["*"],
    }));
  }

  if (auth.signingWalletId) {
    return [{ walletId: auth.signingWalletId, permissions: ["*"] }];
  }

  return [];
}

function getBindingForWallet(auth: ApiKeyContext, walletId: string): ApiKeyWalletBinding | null {
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

function isProjectWalletAllowedForScope(
  keyProjectId: string | null,
  walletProjectId: string | null
): boolean {
  if (!keyProjectId) {
    return walletProjectId === null;
  }

  // Project keys can use org wallets (null) and same-project wallets.
  return walletProjectId === null || walletProjectId === keyProjectId;
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
    throw new AppError("BAD_REQUEST", "walletScope is required");
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
    throw new AppError("BAD_REQUEST", "provisionWallet is only supported during API key creation");
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

export async function assertWalletBindingsInScope(
  db: DatabaseClient,
  organizationId: string,
  keyProjectId: string | null,
  bindings: ApiKeyWalletBinding[]
): Promise<void> {
  if (bindings.length === 0) {
    return;
  }

  const walletIds = bindings.map((binding) => binding.walletId);
  const placeholders = walletIds.map(() => "?").join(", ");

  const rows = await db
    .prepare(
      `SELECT w.wallet_id, c.project_id
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ?
         AND c.status = 'active'
         AND w.status = 'active'
         AND w.wallet_id IN (${placeholders})`
    )
    .bind(organizationId, ...walletIds)
    .all<{ wallet_id: string; project_id: string | null }>();

  const walletScope = new Map<string, string | null>();
  for (const row of rows.results ?? []) {
    if (!walletScope.has(row.wallet_id)) {
      walletScope.set(row.wallet_id, row.project_id);
    }
  }

  const missingWalletIds = walletIds.filter((walletId) => !walletScope.has(walletId));
  if (missingWalletIds.length > 0) {
    throw new AppError("BAD_REQUEST", `Unknown signing wallet IDs: ${missingWalletIds.join(", ")}`);
  }

  for (const walletId of walletIds) {
    const walletProjectId = walletScope.get(walletId) ?? null;
    if (!isProjectWalletAllowedForScope(keyProjectId, walletProjectId)) {
      if (!keyProjectId) {
        throw new AppError("BAD_REQUEST", "Org-level API keys cannot bind to project wallets");
      }

      throw new AppError(
        "BAD_REQUEST",
        "Project API keys cannot bind to wallets from other projects"
      );
    }
  }
}

export function assertApiKeyWalletAccess(
  auth: ApiKeyContext,
  walletId: string,
  requiredPermissions: Permission[] = []
): void {
  if (auth.authType !== "api_key") {
    return;
  }

  const bindings = normalizeBindings(auth);
  if (bindings.length === 0) {
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

  if (auth.signingWalletId) {
    assertApiKeyWalletAccess(auth, auth.signingWalletId, requiredPermissions);
    return auth.signingWalletId;
  }

  const bindings = normalizeBindings(auth);
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

  return null;
}

export function getAllowedApiKeyWalletIds(auth: ApiKeyContext): string[] | null {
  if (auth.authType !== "api_key") {
    return null;
  }

  const bindings = normalizeBindings(auth);
  if (bindings.length === 0) {
    return null;
  }

  return bindings.map((binding) => binding.walletId);
}

export function getAllowedApiKeyWalletIdsForPermissions(
  auth: ApiKeyContext,
  requiredPermissions: Permission[] = []
): string[] | null {
  if (auth.authType !== "api_key") {
    return null;
  }

  const bindings = normalizeBindings(auth);
  if (bindings.length === 0) {
    return null;
  }

  return bindings
    .filter((binding) => hasBindingPermission(binding, requiredPermissions))
    .map((binding) => binding.walletId);
}

export function filterApiKeyWallets<T extends { walletId: string }>(
  auth: ApiKeyContext,
  wallets: T[],
  requiredPermissions: Permission[] = []
): T[] {
  if (auth.authType !== "api_key") {
    return wallets;
  }

  const bindings = normalizeBindings(auth);
  if (bindings.length === 0) {
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
