// Server-side enforcement of the Asset Type Registry's `requiredForDeploy`
// dot-paths (SOLA9-37). The registry marks issuer-entered identity /
// value-attribution fields (e.g. asset.issuerName, asset.pegCurrency for a
// fiat-backed stablecoin) as mandatory before a token may be deployed. The
// dashboard validates them client-side, but the API must fail closed on its
// own: a durable token must never reach the irreversible deploy boundary with
// the fields its registry entry declares required.

import { type AssetCategory, getAssetTypeRegistryEntry, type IssuanceMetadata } from "@sdp/types";
import { badRequest } from "@/lib/errors";
import { getMetadataValueByPath } from "./public-metadata";

export interface RequiredForDeployMetadataError {
  /** The registry dot-path whose value is missing or blank. */
  field: string;
  reason: "required";
}

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return typeof value === "string" && value.trim().length === 0;
}

/**
 * Check every `requiredForDeploy` dot-path of the registry entry for
 * (category, type) against the issuance metadata. Missing, null, empty, and
 * whitespace-only values are reported field-specifically; types that declare
 * no requirements (and unknown pairs, which callers validate separately)
 * always pass.
 */
export function validateRequiredForDeployMetadata(
  category: AssetCategory,
  type: string,
  issuanceMetadata: IssuanceMetadata | undefined
): RequiredForDeployMetadataError[] {
  const entry = getAssetTypeRegistryEntry(category, type);
  if (!entry || entry.requiredForDeploy.length === 0) {
    return [];
  }
  const errors: RequiredForDeployMetadataError[] = [];
  for (const field of entry.requiredForDeploy) {
    if (isBlank(getMetadataValueByPath(issuanceMetadata ?? {}, field))) {
      errors.push({ field, reason: "required" });
    }
  }
  return errors;
}

/**
 * Fail closed with a field-specific 400 when a registry-required issuance
 * metadata value is missing, null, empty, or whitespace-only.
 */
export function assertRequiredForDeployMetadata(
  category: AssetCategory,
  type: string,
  issuanceMetadata: IssuanceMetadata | undefined
): void {
  const errors = validateRequiredForDeployMetadata(category, type, issuanceMetadata);
  if (errors.length > 0) {
    throw badRequest(
      `Asset profile is missing required issuance metadata: ${errors
        .map((error) => error.field)
        .join(", ")}`,
      { errors }
    );
  }
}
