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
import {
  ADVANCED_SETTINGS,
  expandLegacySettingKeys,
  findIncompatibleExtensionPair,
  type SettingKey,
} from "./settings";

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
  // Whether the mint should be initialized WITH a freeze authority. Derived from
  // the "freezeAccounts" selection rather than taken as an input, because that
  // setting is the control for it. A base-mint column rather than an extension,
  // like requiresAllowlist — SPL forbids adding a freeze authority after
  // InitializeMint, so `false` is irreversible once deployed.
  isFreezable: boolean;
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
    case "pauseTransfers":
      return { pausable: {} };
    // "freezeAccounts" intentionally has no case: it maps to the base mint's
    // freeze authority, not an extension, and is surfaced as `isFreezable`.
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
  // Rewrite retired keys before anything reads the selection, so a stored
  // "freezeTransfers" still resolves to the pausable extension and a freeze
  // authority instead of being skipped as unknown below.
  const resolvedSelection = expandLegacySettingKeys(selected);
  const freezeAccountsSelected = "freezeAccounts" in resolvedSelection;

  const capability = ASSET_CAPABILITIES.find((c) => c.category === category && c.type === type);
  if (!capability) {
    return {
      template: "custom",
      decimals: options.decimals ?? 0,
      requiresAllowlist: options.requiresAllowlist ?? false,
      isFreezable: freezeAccountsSelected,
      extensions: null,
      errors: [
        {
          code: "EXTENSION_NOT_ALLOWED",
          message: `No capability entry for ${category}/${type}.`,
        },
      ],
    };
  }

  // "locked" means forced on for this asset family. For locked *extensions* the
  // guarded template already forces them regardless of the selection, but
  // freezeAccounts resolves to a token column with no template to enforce it — so
  // a selection that omits it (a stale draft, or a direct API caller) must still
  // come back freezable.
  const isFreezable = freezeAccountsSelected || capability.settings.freezeAccounts === "locked";

  const authorities = options.authorities ?? {};
  const extensions: ExtensionOverrides = {};
  for (const [key, selection] of Object.entries(resolvedSelection)) {
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
    isFreezable,
    extensions: result.extensions,
    errors,
  };
}
