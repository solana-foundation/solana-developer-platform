/**
 * Template Service
 *
 * Resolves token templates and applies user overrides to produce
 * final token configuration.
 */

import type {
  ExtensionOverrides,
  TokenExtensionName,
  TokenExtensionsConfig,
  TokenTemplate,
  TokenTemplateDefinition,
  TokenTemplateInfo,
} from "@sdp/types";
import { getAllTemplates, getExtensionInfo, getTemplate } from "./definitions";
import type {
  ResolvedTokenConfig,
  TemplateResolutionInput,
  TemplateResolutionResult,
} from "./types";
import { validateTemplateConfig } from "./validation";

// Re-export for convenience
export * from "./types";
export * from "./definitions";
export * from "./validation";

// ═══════════════════════════════════════════════════════════════════════════
// Template Resolution
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve a template with overrides to produce final configuration
 */
export function resolveTemplate(input: TemplateResolutionInput): TemplateResolutionResult {
  // Determine template - default to "custom" for backward compatibility
  const templateId: TokenTemplate = input.template ?? "custom";
  const template = getTemplate(templateId);

  if (!template) {
    return {
      success: false,
      errors: [
        {
          code: "UNKNOWN_TEMPLATE",
          message: `Template '${templateId}' is not recognized`,
          field: "template",
        },
      ],
    };
  }

  // Handle legacy mode: if extensions are provided directly without template
  if (input.extensions && !input.template) {
    return resolveLegacyMode(input);
  }

  // Build enabled extensions list
  const enabledExtensions = buildEnabledExtensions(template, input.overrides?.extensions);

  // Validate configuration
  const errors = validateTemplateConfig(template, input, enabledExtensions);
  if (errors.length > 0) {
    return { success: false, errors };
  }

  // Build final extensions config
  const extensions = buildExtensionsConfig(
    template,
    input.overrides?.extensions,
    enabledExtensions
  );

  // Resolve final config
  const config: ResolvedTokenConfig = {
    decimals: input.decimals ?? template.decimals,
    requiresAllowlist: resolveAllowlistRequirement(template, input),
    extensions,
    template: templateId,
  };

  return { success: true, config };
}

/**
 * Handle legacy mode where extensions are provided directly
 */
function resolveLegacyMode(input: TemplateResolutionInput): TemplateResolutionResult {
  const template = getTemplate("custom");
  if (!template) {
    return {
      success: false,
      errors: [{ code: "INTERNAL_ERROR", message: "Custom template not found" }],
    };
  }

  // For legacy mode, we accept extensions as-is but validate them
  const extensions = input.extensions ?? {};
  const enabledExtensions = getExtensionNamesFromConfig(extensions);

  // Validate extension availability
  const errors = validateTemplateConfig(template, { decimals: input.decimals }, enabledExtensions);
  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    config: {
      decimals: input.decimals ?? template.decimals,
      requiresAllowlist: input.requiresAllowlist ?? false,
      extensions,
      template: "custom",
    },
  };
}

/**
 * Check if an override value indicates the extension should be disabled
 */
function isDisabled(value: unknown): boolean {
  return value === false;
}

/**
 * Check if an override value indicates the extension should be enabled
 */
function isEnabled(value: unknown): boolean {
  return value !== undefined && value !== false;
}

/**
 * Build list of enabled extensions from template defaults + overrides
 */
function buildEnabledExtensions(
  template: TokenTemplateDefinition,
  overrides?: ExtensionOverrides
): TokenExtensionName[] {
  const enabled = new Set<TokenExtensionName>();

  // Add required extensions (always enabled)
  for (const ext of template.extensions.required) {
    enabled.add(ext);
  }

  // Add default-enabled extensions (unless disabled via override)
  for (const ext of template.extensions.defaultEnabled) {
    const override = overrides?.[ext as keyof ExtensionOverrides];
    if (!isDisabled(override)) {
      enabled.add(ext);
    }
  }

  // Add available extensions if explicitly enabled
  if (overrides) {
    for (const ext of template.extensions.available) {
      const override = overrides[ext as keyof ExtensionOverrides];
      if (isEnabled(override)) {
        enabled.add(ext);
      }
    }
  }

  return Array.from(enabled);
}

/**
 * Build final extensions configuration
 */
function buildExtensionsConfig(
  template: TokenTemplateDefinition,
  overrides?: ExtensionOverrides,
  enabledExtensions?: TokenExtensionName[]
): TokenExtensionsConfig {
  const config: TokenExtensionsConfig = {};
  const enabled = enabledExtensions ?? buildEnabledExtensions(template, overrides);

  // Apply template defaults for enabled extensions
  if (enabled.includes("defaultAccountState")) {
    config.defaultAccountState = template.defaultExtensions.defaultAccountState ?? "initialized";
  }

  if (enabled.includes("permanentDelegate")) {
    // Will be set to platform authority at deployment
    config.permanentDelegate = template.defaultExtensions.permanentDelegate;
  }

  if (enabled.includes("confidentialTransfer")) {
    config.confidentialTransfer = true;
  }

  if (enabled.includes("nonTransferable")) {
    config.nonTransferable = true;
  }

  // Apply overrides
  if (overrides) {
    applyExtensionOverrides(config, overrides, enabled);
  }

  return config;
}

/**
 * Apply extension overrides to config
 */
function applyExtensionOverrides(
  config: TokenExtensionsConfig,
  overrides: ExtensionOverrides,
  enabledExtensions: TokenExtensionName[]
): void {
  // Transfer fee - check it's enabled and has config (not false)
  const transferFee = overrides.transferFee;
  if (enabledExtensions.includes("transferFee") && transferFee && typeof transferFee === "object") {
    config.transferFee = {
      basisPoints: transferFee.basisPoints,
      maxFee: transferFee.maxFee,
      transferFeeConfigAuthority: transferFee.transferFeeConfigAuthority ?? "",
      withdrawWithheldAuthority: transferFee.withdrawWithheldAuthority ?? "",
    };
  }

  // Interest bearing - check it's enabled and has config (not false)
  const interestBearing = overrides.interestBearing;
  if (
    enabledExtensions.includes("interestBearing") &&
    interestBearing &&
    typeof interestBearing === "object"
  ) {
    config.interestBearing = {
      rate: interestBearing.rate,
      rateAuthority: interestBearing.rateAuthority ?? "",
    };
  }

  // Default account state override
  if (overrides.defaultAccountState) {
    config.defaultAccountState = overrides.defaultAccountState;
  }

  // Non-transferable override (can only enable, not disable if required)
  if (overrides.nonTransferable === true) {
    config.nonTransferable = true;
  }

  // Confidential transfer override
  if (overrides.confidentialTransfer === true) {
    config.confidentialTransfer = true;
  } else if (
    overrides.confidentialTransfer === false &&
    !enabledExtensions.includes("confidentialTransfer")
  ) {
    // Only allow disabling if it was optional (defaultEnabled, not required)
    config.confidentialTransfer = undefined;
  }
}

/**
 * Resolve allowlist requirement based on template and overrides
 */
function resolveAllowlistRequirement(
  template: TokenTemplateDefinition,
  input: TemplateResolutionInput
): boolean {
  // Check if override is provided
  const override = input.overrides?.requiresAllowlist ?? input.requiresAllowlist;

  if (override !== undefined) {
    // If template requires allowlist and it's not overridable, enforce it
    if (template.requiresAllowlist && !template.allowlistOverridable) {
      return true;
    }
    return override;
  }

  // Use template default
  return template.requiresAllowlist;
}

/**
 * Extract extension names from a config object
 */
function getExtensionNamesFromConfig(config: TokenExtensionsConfig): TokenExtensionName[] {
  const extensions: TokenExtensionName[] = [];

  if (config.confidentialTransfer) extensions.push("confidentialTransfer");
  if (config.transferFee) extensions.push("transferFee");
  if (config.interestBearing) extensions.push("interestBearing");
  if (config.permanentDelegate) extensions.push("permanentDelegate");
  if (config.nonTransferable) extensions.push("nonTransferable");
  if (config.defaultAccountState) extensions.push("defaultAccountState");
  if (config.metadataPointer) extensions.push("metadataPointer");
  if (config.groupPointer) extensions.push("groupPointer");

  return extensions;
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Info for API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert template definition to API response format
 */
export function toTemplateInfo(template: TokenTemplateDefinition): TokenTemplateInfo {
  const mapExtensions = (names: TokenExtensionName[]) =>
    names.map((name) => ({
      name,
      ...getExtensionInfo(name),
    }));

  return {
    id: template.id,
    name: template.name,
    description: template.description,
    decimals: template.decimals,
    maxDecimals: template.maxDecimals,
    requiresAllowlist: template.requiresAllowlist,
    allowlistOverridable: template.allowlistOverridable,
    extensions: {
      required: mapExtensions(template.extensions.required),
      defaultEnabled: mapExtensions(template.extensions.defaultEnabled),
      available: mapExtensions(template.extensions.available),
    },
  };
}

/**
 * Get all templates as API response format
 */
export function listTemplates(): TokenTemplateInfo[] {
  return getAllTemplates().map(toTemplateInfo);
}

/**
 * Get a single template as API response format
 */
export function getTemplateInfo(id: string): TokenTemplateInfo | undefined {
  const template = getTemplate(id);
  return template ? toTemplateInfo(template) : undefined;
}
