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
 * A dot-path is safe to expose publicly iff it lives in the `asset.*` namespace
 * or is the on-chain `chain.decimals`. `compliance.*`, `custom.*`, and
 * `visibility.*` can never be projected — no matter what a client puts in
 * `visibility.public` — so private fields cannot leak through the public token
 * metadata URI. This namespace clamp is the single enforcement point.
 */
function isPublicSafePath(path: string): boolean {
  return path.startsWith("asset.") || path === "chain.decimals";
}

/**
 * Build the safe public metadata subset for an asset by copying selected
 * dot-paths out of the full (private) issuance metadata.
 *
 * The issuer's own selection (`issuanceMetadata.visibility.public`) decides
 * which paths are published; when it is absent (legacy profiles), the Asset
 * Type Registry's `publicProjection` is used as the default. Either way every
 * candidate path is clamped by {@link isPublicSafePath}, so `compliance.*` and
 * `custom.*` are never copied even if a client asks for them. Paths that are
 * absent in the source are skipped.
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

  const requested = issuanceMetadata.visibility?.public;
  const selected = Array.isArray(requested)
    ? requested.filter((path): path is string => typeof path === "string")
    : entry.publicProjection;

  const projected: Record<string, unknown> = {};
  for (const path of selected) {
    if (!isPublicSafePath(path)) {
      continue;
    }
    const value = getByPath(issuanceMetadata, path);
    if (value !== undefined) {
      setByPath(projected, path, value);
    }
  }
  return projected;
}
