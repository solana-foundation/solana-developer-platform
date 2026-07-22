// Settings → extension-config resolver: maps settings to ExtensionOverrides,
// validates at save time, injects real authorities at deploy time.
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

export interface ExtensionAuthorities {
  permanentDelegate?: string;
}

// Authority-valued settings: resolver injects real wallet; placeholder would brick token.
export const AUTHORITY_VALUED_SETTINGS: readonly SettingKey[] = ["permanentDelegate"];

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

// Coerce to finite number else fallback; rejects NaN/±Infinity before post-deploy fields.
function toNumber(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
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

function toOverride(
  key: SettingKey,
  params: Record<string, string | number>,
  authorities: ExtensionAuthorities
): Partial<ExtensionOverrides> {
  switch (key) {
    case "freezeTransfers":
      return { pausable: {} };
    case "permanentDelegate":
      // Authority-valued: emit only with real wallet; omit to avoid bricking.
      return authorities.permanentDelegate
        ? { permanentDelegate: authorities.permanentDelegate }
        : {};
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
    case "transferHook": {
      // No valid default; omit when absent to avoid bricking transfers.
      const programId = toStringValue(params.programId, "");
      return programId ? { transferHook: { programId } } : {};
    }
    default:
      return {};
  }
}

// Resolve to deployment-ready config (extensions, decimals, allowlist, errors).
// Base template from capability; unknown keys skipped; inject authorities for real wallets.
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

  // Catch pairwise extension conflicts not covered by template checks.
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
