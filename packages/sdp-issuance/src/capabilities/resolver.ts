// The settings → extension-config resolver (ticket A). Converts a stored
// advanced-settings selection into a deployment-ready TokenExtensionsConfig by
// mapping each selected setting to its ExtensionOverrides fragment and running
// the existing resolveTemplateConfig against the asset type's base template.
//
// Pure and mosaic-free (only @sdp/types + ./templates/definitions), so it runs
// both at settings-save time (validation: surface resolver errors early) and at
// deploy time (produce the payload, with real authorities injected).
//
// See docs/decisions/0002-asset-advanced-settings.md.

import type {
  AssetCategory,
  ExtensionOverrides,
  SelectedSetting,
  TokenExtensionName,
  TokenExtensionsConfig,
  TokenTemplate,
} from "@sdp/types";
import { resolveTemplateConfig, type TemplateOverrideError } from "../templates/definitions";
import { ASSET_CAPABILITIES } from "./capabilities";
import { ADVANCED_SETTINGS, findIncompatibleExtensionPair, type SettingKey } from "./settings";

// Authority-valued extension config isn't known until deploy (SDP resolves the
// controlled wallet then). When absent — e.g. validating a draft before deploy —
// a placeholder stands in so resolveTemplateConfig can validate the extension
// key; the value is never persisted and deploy injects the real authority.
// resolveTemplateConfig validates keys, not values, so any non-empty string works.
const PLACEHOLDER_AUTHORITY = "11111111111111111111111111111111";

// Authorities injected for authority-valued extensions. At token create the
// caller passes the controlled signing wallet (which becomes custody at deploy),
// so no placeholder is ever stored for e.g. permanentDelegate.
export interface ExtensionAuthorities {
  permanentDelegate?: string;
}

export interface ResolveSettingsOptions {
  authorities?: ExtensionAuthorities;
  decimals?: number;
  requiresAllowlist?: boolean;
}

export interface SettingsResolution {
  template: TokenTemplate;
  decimals: number;
  requiresAllowlist: boolean;
  extensions: TokenExtensionsConfig | null;
  errors: TemplateOverrideError[];
}

function toNumber(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function toStringValue(value: string | number | undefined, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return fallback;
}

// Map one selected setting to the ExtensionOverrides fragment it enables.
function toOverride(
  key: SettingKey,
  params: Record<string, string | number>,
  authorities: ExtensionAuthorities
): Partial<ExtensionOverrides> {
  switch (key) {
    case "freezeTransfers":
      return { pausable: {} };
    case "permanentDelegate":
      return { permanentDelegate: authorities.permanentDelegate ?? PLACEHOLDER_AUTHORITY };
    case "scaledUiAmount":
      return { scaledUiAmount: { multiplier: toNumber(params.multiplier, 1) } };
    case "transferFee":
      return {
        transferFee: {
          basisPoints: toNumber(params.basisPoints, 0),
          maxFee: toStringValue(params.maxFee, "0"),
        },
      };
    case "interestBearing":
      return { interestBearing: { rate: toNumber(params.rate, 0) } };
    case "nonTransferable":
      return { nonTransferable: true };
    case "transferHook":
      return {
        transferHook: { programId: toStringValue(params.programId, PLACEHOLDER_AUTHORITY) },
      };
    default:
      return {};
  }
}

// Resolve a selection into a deployment-ready extension config (plus decimals,
// allowlist, and any template errors). The base template comes from the asset
// type's capability — the profile is the source of truth. Unknown setting keys
// are skipped defensively (the caller validates them against the capability
// first). Pass the controlled wallet in `options.authorities` so authority-valued
// extensions resolve to a real address rather than a placeholder.
export function resolveSettingsToExtensions(
  category: AssetCategory,
  type: string,
  selected: Record<string, SelectedSetting>,
  options: ResolveSettingsOptions = {}
): SettingsResolution {
  const capability = ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
  if (!capability) {
    return {
      template: "custom",
      decimals: options.decimals ?? 0,
      requiresAllowlist: options.requiresAllowlist ?? false,
      extensions: null,
      errors: [
        {
          code: "EXTENSION_NOT_ALLOWED",
          message: `No capability entry for ${category}/${type}.`,
        },
      ],
    };
  }

  const authorities = options.authorities ?? {};
  const extensions: ExtensionOverrides = {};
  for (const [key, selection] of Object.entries(selected)) {
    if (!(key in ADVANCED_SETTINGS)) {
      continue;
    }
    Object.assign(extensions, toOverride(key as SettingKey, selection?.params ?? {}, authorities));
  }

  const result = resolveTemplateConfig(
    capability.baseTemplate,
    { extensions },
    options.requiresAllowlist,
    options.decimals
  );

  // Pairwise conflict check: two individually-valid extensions that can't coexist
  // on one mint (e.g. interestBearing + scaledUiAmount). The per-template check
  // in resolveTemplateConfig can't catch this, so surface it here — early at
  // settings-save and again defensively at deploy.
  const errors = [...result.errors];
  const conflict = findIncompatibleExtensionPair(Object.keys(extensions) as TokenExtensionName[]);
  if (conflict) {
    errors.push({
      code: "EXTENSION_NOT_ALLOWED",
      message: `${conflict[0]} and ${conflict[1]} cannot be combined on the same token.`,
      extension: conflict[1],
    });
  }

  return {
    template: result.template,
    decimals: result.decimals,
    requiresAllowlist: result.requiresAllowlist,
    extensions: result.extensions,
    errors,
  };
}
