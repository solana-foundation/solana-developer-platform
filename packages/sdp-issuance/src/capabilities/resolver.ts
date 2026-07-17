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
  TokenExtensionsConfig,
  TokenTemplate,
} from "@sdp/types";
import { resolveTemplateConfig, type TemplateOverrideError } from "../templates/definitions";
import { ASSET_CAPABILITIES } from "./capabilities";
import { ADVANCED_SETTINGS, type SettingKey } from "./settings";

// Authority-valued extension config isn't known until deploy (SDP resolves the
// controlled wallet then). When absent — e.g. validating a draft before deploy —
// a placeholder stands in so resolveTemplateConfig can validate the extension
// key; the value is never persisted and deploy injects the real authority.
// resolveTemplateConfig validates keys, not values, so any non-empty string works.
const PLACEHOLDER_AUTHORITY = "11111111111111111111111111111111";

// Authorities injected at deploy time for authority-valued extensions.
export interface ExtensionAuthorities {
  permanentDelegate?: string;
}

export interface SettingsResolution {
  template: TokenTemplate;
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

// Resolve a selection into a deployment-ready extension config plus any template
// errors. Unknown setting keys are skipped defensively (the caller validates
// them against the capability first); pass `authorities` at deploy time.
export function resolveSettingsToExtensions(
  category: AssetCategory,
  type: string,
  selected: Record<string, SelectedSetting>,
  authorities: ExtensionAuthorities = {}
): SettingsResolution {
  const capability = ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
  if (!capability) {
    return {
      template: "custom",
      extensions: null,
      errors: [
        {
          code: "EXTENSION_NOT_ALLOWED",
          message: `No capability entry for ${category}/${type}.`,
        },
      ],
    };
  }

  const extensions: ExtensionOverrides = {};
  for (const [key, selection] of Object.entries(selected)) {
    if (!(key in ADVANCED_SETTINGS)) {
      continue;
    }
    Object.assign(extensions, toOverride(key as SettingKey, selection?.params ?? {}, authorities));
  }

  const result = resolveTemplateConfig(capability.baseTemplate, { extensions });
  return { template: result.template, extensions: result.extensions, errors: result.errors };
}
