import type { ApiKeyContext } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { ApiKeyWalletBinding, Permission } from "@sdp/types";

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

  const binding = bindings.find((entry) => entry.walletId === walletId);
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
