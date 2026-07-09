import type {
  ExtensionOverrides,
  TokenExtensionName,
  TokenExtensionsConfig,
  TokenTemplate,
  TokenTemplateDefinition,
  TokenTemplateOverrides,
} from "@sdp/types";

const CUSTOM_AVAILABLE_EXTENSIONS: TokenExtensionName[] = [
  "transferFee",
  "interestBearing",
  "permanentDelegate",
  "pausable",
  "nonTransferable",
  "defaultAccountState",
  "scaledUiAmount",
  "transferHook",
];

const STABLECOIN_OVERRIDE_EXTENSIONS: TokenExtensionName[] = ["permanentDelegate", "pausable"];
const ARCADE_OVERRIDE_EXTENSIONS: TokenExtensionName[] = ["permanentDelegate", "pausable"];
const TOKENIZED_SECURITY_OVERRIDE_EXTENSIONS: TokenExtensionName[] = [
  "permanentDelegate",
  "pausable",
  "scaledUiAmount",
];

type CanonicalTemplate = Exclude<TokenTemplate, "rwa">;

export const TEMPLATE_DEFINITIONS: Record<CanonicalTemplate, TokenTemplateDefinition> = {
  stablecoin: {
    id: "stablecoin",
    name: "Stablecoin",
    description: "USD-backed stablecoins with configurable allowlist or denylist controls.",
    decimals: 6,
    maxDecimals: 18,
    requiresAllowlist: false,
    allowlistOverridable: true,
    extensions: {
      required: ["permanentDelegate", "pausable"],
      defaultEnabled: ["defaultAccountState"],
      available: STABLECOIN_OVERRIDE_EXTENSIONS,
      incompatible: [],
    },
    defaultExtensions: {
      defaultAccountState: "initialized",
    },
  },
  arcade: {
    id: "arcade",
    name: "Arcade",
    description: "Closed-loop gaming tokens with optional allowlists.",
    decimals: 0,
    maxDecimals: 9,
    requiresAllowlist: false,
    allowlistOverridable: true,
    extensions: {
      required: ["permanentDelegate", "pausable"],
      defaultEnabled: ["defaultAccountState"],
      available: ARCADE_OVERRIDE_EXTENSIONS,
      incompatible: [],
    },
    defaultExtensions: {
      defaultAccountState: "initialized",
    },
  },
  "tokenized-security": {
    id: "tokenized-security",
    name: "Tokenized Security",
    description: "Regulated assets with configurable allowlist or denylist controls.",
    decimals: 8,
    maxDecimals: 18,
    requiresAllowlist: true,
    allowlistOverridable: true,
    extensions: {
      required: ["permanentDelegate", "pausable", "scaledUiAmount"],
      defaultEnabled: ["defaultAccountState"],
      available: TOKENIZED_SECURITY_OVERRIDE_EXTENSIONS,
      incompatible: [],
    },
    defaultExtensions: {
      defaultAccountState: "frozen",
    },
  },
  custom: {
    id: "custom",
    name: "Custom",
    description: "Fully customizable Token-2022 configuration.",
    decimals: 9,
    maxDecimals: 18,
    requiresAllowlist: false,
    allowlistOverridable: true,
    extensions: {
      required: [],
      defaultEnabled: [],
      available: CUSTOM_AVAILABLE_EXTENSIONS,
      incompatible: [],
    },
    defaultExtensions: {},
  },
};

export interface TemplateOverrideError {
  code: "ALLOWLIST_REQUIRED" | "EXTENSION_NOT_ALLOWED";
  message: string;
  extension?: TokenExtensionName;
}

export interface TemplateResolutionResult {
  template: TokenTemplate;
  decimals: number;
  requiresAllowlist: boolean;
  extensions: TokenExtensionsConfig | null;
  errors: TemplateOverrideError[];
}

export const normalizeTemplateId = (id?: string): CanonicalTemplate => {
  if (!id) {
    return "custom";
  }
  if (id === "tokenized_security" || id === "rwa") {
    return "tokenized-security";
  }
  return id as CanonicalTemplate;
};

const cloneExtensions = (
  extensions: Partial<TokenExtensionsConfig> | undefined
): Partial<TokenExtensionsConfig> => {
  if (!extensions) {
    return {};
  }
  return JSON.parse(JSON.stringify(extensions)) as Partial<TokenExtensionsConfig>;
};

const applyExtensionOverride = (
  base: Partial<TokenExtensionsConfig>,
  extension: TokenExtensionName,
  value: ExtensionOverrides[TokenExtensionName]
): void => {
  if (value === undefined) {
    return;
  }

  if (value === false) {
    delete (base as Record<string, unknown>)[extension];
    return;
  }

  (base as Record<string, unknown>)[extension] = value;
};

export function resolveTemplateConfig(
  templateId: TokenTemplate,
  overrides?: TokenTemplateOverrides,
  requiresAllowlistOverride?: boolean,
  decimalsOverride?: number
): TemplateResolutionResult {
  const normalizedTemplate = normalizeTemplateId(templateId);
  const definition = TEMPLATE_DEFINITIONS[normalizedTemplate];
  const errors: TemplateOverrideError[] = [];

  const decimals = decimalsOverride ?? definition.decimals;
  let requiresAllowlist = definition.requiresAllowlist;
  const requestedAllowlist = overrides?.requiresAllowlist ?? requiresAllowlistOverride ?? undefined;

  if (requestedAllowlist !== undefined) {
    if (!definition.allowlistOverridable && requestedAllowlist !== definition.requiresAllowlist) {
      errors.push({
        code: "ALLOWLIST_REQUIRED",
        message: `${definition.name} tokens require allowlist enforcement.`,
      });
    } else {
      requiresAllowlist = requestedAllowlist;
    }
  }

  const baseExtensions = cloneExtensions(definition.defaultExtensions);
  if ("defaultAccountState" in baseExtensions) {
    baseExtensions.defaultAccountState = requiresAllowlist ? "frozen" : "initialized";
  }
  const allowedOverrides = new Set<TokenExtensionName>(definition.extensions.available);
  const incompatibleExtensions = new Set<TokenExtensionName>(definition.extensions.incompatible);

  if (overrides?.extensions) {
    for (const [key, value] of Object.entries(overrides.extensions)) {
      const extension = key as TokenExtensionName;

      if (incompatibleExtensions.has(extension) || !allowedOverrides.has(extension)) {
        errors.push({
          code: "EXTENSION_NOT_ALLOWED",
          message: `${definition.name} does not support ${extension} extension.`,
          extension,
        });
        continue;
      }

      if (value === false && definition.extensions.required.includes(extension)) {
        errors.push({
          code: "EXTENSION_NOT_ALLOWED",
          message: `${extension} is required for ${definition.name} template.`,
          extension,
        });
        continue;
      }

      applyExtensionOverride(
        baseExtensions,
        extension,
        value as ExtensionOverrides[TokenExtensionName]
      );
    }
  }

  const extensions = Object.keys(baseExtensions).length
    ? (baseExtensions as TokenExtensionsConfig)
    : null;

  return {
    template: definition.id,
    decimals,
    requiresAllowlist,
    extensions,
    errors,
  };
}
