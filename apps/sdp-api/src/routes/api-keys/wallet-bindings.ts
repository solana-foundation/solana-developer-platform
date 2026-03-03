import { AppError } from "@/lib/errors";
import { normalizeApiKeyWalletPermissions } from "@/services/api-key-wallets.service";
import type { ApiKeyWalletBinding, Permission } from "@sdp/types";

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

function trimWalletId(walletId: string): string {
  const normalized = walletId.trim();
  if (!normalized) {
    throw new AppError("BAD_REQUEST", "Wallet IDs must be non-empty strings");
  }
  return normalized;
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

export async function assertWalletBindingsInScope(
  db: D1Database,
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
