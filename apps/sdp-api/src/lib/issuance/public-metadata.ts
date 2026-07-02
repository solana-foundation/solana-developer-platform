import {
  type AssetCategory,
  getAssetTypeRegistryEntry,
  type IssuanceMetadata,
  type PublicTokenMetadata,
} from "@sdp/types";

function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.length === 0) {
    return;
  }

  const isUnsafeKey = (key: string): boolean =>
    key === "__proto__" || key === "constructor" || key === "prototype";

  let cursor = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (isUnsafeKey(key)) {
      return;
    }

    const next = cursor[key];
    if (!next || typeof next !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (isUnsafeKey(lastKey)) {
    return;
  }
  cursor[lastKey] = value;
}

/**
 * Build the safe public metadata subset for an asset by copying exactly the
 * dot-paths the Asset Type Registry marks as public out of the full (private)
 * issuance metadata. Anything not listed — notably `compliance.*` and
 * `custom.*` — is never copied, so private fields cannot leak through the
 * public token metadata URI. Paths that are absent in the source are skipped.
 *
 * Returns an empty object for unknown (category, type) pairs; callers validate
 * the pair against the registry before persisting.
 */
export function projectPublicMetadata(
  category: AssetCategory,
  type: string,
  issuanceMetadata: IssuanceMetadata
): PublicTokenMetadata {
  const entry = getAssetTypeRegistryEntry(category, type);
  if (!entry) {
    return {};
  }

  const projected: Record<string, unknown> = {};
  for (const path of entry.publicProjection) {
    const value = getByPath(issuanceMetadata, path);
    if (value !== undefined) {
      setByPath(projected, path, value);
    }
  }
  return projected;
}
