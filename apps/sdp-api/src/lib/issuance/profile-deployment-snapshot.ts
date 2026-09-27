// Bridge between an asset profile's reviewed advanced settings and the
// deployment snapshot a pending token deploys from (APE-848 / SOLA9-632).
//
// The profile's `issuanceMetadata.settings.selected` is the reviewed source of
// truth for the token's `template`, freeze-authority flag, allowlist flag and
// extension rows. Both writers of that contract go through the same creation-
// time resolver here, so a save and a deploy-check can never disagree about
// what the selection means. Legacy profiles (template + overrides, no
// settings) assert nothing and are out of scope for both paths.
//
// Safe to import @sdp/issuance/capabilities here (mosaic-free).

import {
  resolveSettingsToExtensions,
  type TemplateOverrideError,
} from "@sdp/issuance/capabilities";
import type {
  AssetCategory,
  IssuanceMetadata,
  Token,
  TokenExtensionsConfig,
  TokenTemplate,
} from "@sdp/types";
import { getSelectedSettings } from "./advanced-settings";

/** What a profile's selection resolves to for a token's deployment snapshot. */
export interface ResolvedProfileSnapshot {
  template: TokenTemplate;
  isFreezable: boolean;
  requiresAllowlist: boolean;
  extensions: TokenExtensionsConfig | null;
  // Non-empty when the selection no longer resolves against the token's
  // inputs (e.g. a template-forced allowlist conflict) — as fatal as any
  // other resolver error on both the save and the deploy-check path.
  errors: TemplateOverrideError[];
}

/**
 * How long a client-signed deploy prepare can still land on-chain, for the
 * profile-save fence. The prepared transaction's blockhash stays valid for at
 * most a couple of minutes; the window is generous past that for clock skew
 * and slow confirmations, because a rewrite inside it can strand the submitted
 * mint while a rewrite after it cannot.
 */
export const PREPARED_DEPLOY_FENCE_MS = 15 * 60 * 1000;

/** True when the profile asserts the capability-derived settings path at all. */
export function profileUsesAdvancedSettings(
  metadata: IssuanceMetadata | null | undefined
): boolean {
  return Object.keys(getSelectedSettings(metadata ?? ({} as IssuanceMetadata))).length > 0;
}

/**
 * Resolve a profile's saved selection to the deployment snapshot its pending
 * token must carry. An empty selection resolves to the capability's base
 * template with no overrides — the same output a create with that selection
 * would persist — so a save that clears the settings rewrites the pending
 * snapshot back to that baseline (APE-848). Callers gate on
 * {@link profileUsesAdvancedSettings}: a profile that never asserted settings
 * (legacy template + overrides) has nothing to assert or sync.
 */
export function resolveProfileDeploymentSnapshot(params: {
  assetCategory: AssetCategory;
  assetType: string;
  issuanceMetadata: IssuanceMetadata | null | undefined;
  // Current token columns the resolver consumes as inputs.
  decimals: number;
  requiresAllowlist: boolean;
  // Real authority for authority-valued settings, exactly like creation: the
  // token's existing delegate when stamped, else the signing wallet's key.
  permanentDelegateAuthority?: string;
}): ResolvedProfileSnapshot {
  const selected = getSelectedSettings(params.issuanceMetadata ?? ({} as IssuanceMetadata));
  const { template, isFreezable, requiresAllowlist, extensions, errors } =
    resolveSettingsToExtensions(params.assetCategory, params.assetType, selected, {
      decimals: params.decimals,
      requiresAllowlist: params.requiresAllowlist,
      authorities: params.permanentDelegateAuthority
        ? { permanentDelegate: params.permanentDelegateAuthority }
        : undefined,
    });
  return { template, isFreezable, requiresAllowlist, extensions, errors };
}

// Authority values are per-deployment wallet state, not policy: both sides of
// the deploy check strip them (the stored delegate becomes a shared marker) so
// the comparison judges which extensions are selected with which reviewed
// params, never which wallet controls them. Creation/deploy inject these
// fields from the signing wallet, so the resolver's selection output never
// carries them and comparing them raw would reject every consistent token.
const DELEGATE_COMPARISON_MARKER = "__profile-snapshot-check__";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function normalizedTokenExtensions(
  extensions: TokenExtensionsConfig | null
): TokenExtensionsConfig | null {
  if (!extensions) {
    return null;
  }
  const clone: Record<string, unknown> = { ...extensions };
  if (typeof clone.permanentDelegate === "string") {
    clone.permanentDelegate = DELEGATE_COMPARISON_MARKER;
  }
  if (clone.transferFee && typeof clone.transferFee === "object") {
    const {
      transferFeeConfigAuthority: _a,
      withdrawWithheldAuthority: _b,
      ...transferFee
    } = clone.transferFee as Record<string, unknown>;
    clone.transferFee = transferFee;
  }
  for (const key of ["interestBearing", "pausable", "scaledUiAmount", "transferHook"] as const) {
    const value = clone[key];
    if (value && typeof value === "object" && "authority" in (value as Record<string, unknown>)) {
      const { authority: _a, ...rest } = value as Record<string, unknown>;
      clone[key] = rest;
    }
  }
  return clone as TokenExtensionsConfig;
}

/** The profile fields the snapshot resolution consumes (row or mapped shape). */
export interface ProfileSnapshotSource {
  assetCategory: AssetCategory;
  assetType: string;
  issuanceMetadata: IssuanceMetadata | null;
}

/**
 * Deploy-time backstop: does the profile's saved selection still resolve to
 * the snapshot this token would deploy from?
 *
 * A pending token whose snapshot and reviewed profile disagree (rows created
 * before the settings save synced them, or a drifted legacy row) must not
 * deploy — the mint is irreversible and would freeze in whichever side is
 * wrong. Returns false also when the selection no longer resolves (e.g. a
 * setting retired for this asset type), for the same reason.
 */
export function profileSnapshotMatchesToken(
  profile: ProfileSnapshotSource,
  token: Pick<Token, "decimals" | "requiresAllowlist" | "isFreezable" | "template" | "extensions">
): boolean {
  if (!profileUsesAdvancedSettings(profile.issuanceMetadata)) {
    // Legacy template + overrides token: the profile asserts nothing.
    return true;
  }
  const selected = getSelectedSettings(profile.issuanceMetadata ?? ({} as IssuanceMetadata));
  const delegateSelected = "permanentDelegate" in selected;
  const tokenDelegate = typeof token.extensions?.permanentDelegate === "string";
  const snapshot = resolveProfileDeploymentSnapshot({
    assetCategory: profile.assetCategory,
    assetType: profile.assetType,
    issuanceMetadata: profile.issuanceMetadata,
    decimals: token.decimals,
    requiresAllowlist: token.requiresAllowlist,
    // The stored delegate (or a marker when creation will inject one) keeps the
    // comparison about extension presence, not wallet identity.
    permanentDelegateAuthority:
      delegateSelected || tokenDelegate
        ? typeof token.extensions?.permanentDelegate === "string"
          ? token.extensions.permanentDelegate
          : DELEGATE_COMPARISON_MARKER
        : undefined,
  });
  return (
    snapshot.errors.length === 0 &&
    snapshot.template === token.template &&
    snapshot.isFreezable === token.isFreezable &&
    snapshot.requiresAllowlist === token.requiresAllowlist &&
    canonicalJson(normalizedTokenExtensions(snapshot.extensions)) ===
      canonicalJson(normalizedTokenExtensions(token.extensions))
  );
}

/**
 * Does a save's resolved snapshot differ from what the pending token currently
 * carries? Same normalization as the deploy check: a save that would rewrite
 * any snapshot field is the one that can strand an in-flight prepared deploy,
 * while a value-identical re-save (e.g. metadata-only) is harmless.
 */
export function resolvedSnapshotEqualsTokenSnapshot(
  resolved: Pick<
    ResolvedProfileSnapshot,
    "template" | "isFreezable" | "requiresAllowlist" | "extensions"
  >,
  token: Pick<Token, "template" | "isFreezable" | "requiresAllowlist" | "extensions">
): boolean {
  return (
    resolved.template === token.template &&
    resolved.isFreezable === token.isFreezable &&
    resolved.requiresAllowlist === token.requiresAllowlist &&
    canonicalJson(normalizedTokenExtensions(resolved.extensions)) ===
      canonicalJson(normalizedTokenExtensions(token.extensions))
  );
}
