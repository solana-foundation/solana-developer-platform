/**
 * Template Validation Service
 *
 * Validates template configurations and extension combinations.
 */

import type { ExtensionOverrides, TokenExtensionName, TokenTemplateDefinition } from "@sdp/types";
import { extensionStatus } from "./definitions";
import type { TemplateValidationError } from "./types";

/**
 * Global extension incompatibilities (applies to all templates)
 */
const globalIncompatibilities: Array<[TokenExtensionName, TokenExtensionName]> = [
  ["nonTransferable", "transferFee"], // Can't charge fees on non-transferable tokens
];

/**
 * Validate that required extensions are not disabled
 */
export function validateRequiredExtensions(
  template: TokenTemplateDefinition,
  overrides?: ExtensionOverrides
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (!overrides) {
    return errors;
  }

  const extensionOverrides = overrides as Record<string, unknown>;

  for (const required of template.extensions.required) {
    const override = extensionOverrides[required];
    if (override === false) {
      errors.push({
        code: "REQUIRED_EXTENSION_DISABLED",
        message: `Extension '${required}' is required for ${template.id} template and cannot be disabled`,
        extension: required,
      });
    }
  }

  return errors;
}

/**
 * Validate extension compatibility
 */
export function validateExtensionCompatibility(
  template: TokenTemplateDefinition,
  enabledExtensions: TokenExtensionName[]
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  // Check template-specific incompatibilities
  for (const ext of enabledExtensions) {
    if (template.extensions.incompatible.includes(ext)) {
      errors.push({
        code: "INCOMPATIBLE_EXTENSION",
        message: `Extension '${ext}' is incompatible with ${template.id} template`,
        extension: ext,
      });
    }
  }

  // Check global incompatibilities
  for (const [ext1, ext2] of globalIncompatibilities) {
    if (enabledExtensions.includes(ext1) && enabledExtensions.includes(ext2)) {
      errors.push({
        code: "EXTENSION_CONFLICT",
        message: `Extensions '${ext1}' and '${ext2}' cannot be used together`,
        extension: ext1,
      });
    }
  }

  return errors;
}

/**
 * Validate that extensions are implemented and enabled
 */
export function validateExtensionAvailability(
  extensions: TokenExtensionName[],
  options: { allowFeatureFlagged?: boolean } = {}
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  for (const ext of extensions) {
    const status = extensionStatus[ext];

    if (!status) {
      errors.push({
        code: "UNKNOWN_EXTENSION",
        message: `Extension '${ext}' is not recognized`,
        extension: ext,
      });
      continue;
    }

    if (status.status === "planned") {
      errors.push({
        code: "EXTENSION_NOT_IMPLEMENTED",
        message: `Extension '${ext}' is not yet implemented`,
        extension: ext,
      });
      continue;
    }

    // Check feature flag unless caller allows feature-flagged extensions
    if (status.status === "implemented" && !status.enabled && !options.allowFeatureFlagged) {
      errors.push({
        code: "EXTENSION_DISABLED",
        message: `Extension '${ext}' is currently disabled. It will be available in a future release.`,
        extension: ext,
      });
    }
  }

  return errors;
}

/**
 * Validate decimals against template limits
 */
export function validateDecimals(
  template: TokenTemplateDefinition,
  decimals?: number
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (decimals === undefined) {
    return errors;
  }

  if (decimals < 0) {
    errors.push({
      code: "INVALID_DECIMALS",
      message: "Decimals cannot be negative",
      field: "decimals",
    });
  }

  if (decimals > template.maxDecimals) {
    errors.push({
      code: "DECIMALS_EXCEEDS_MAX",
      message: `Decimals cannot exceed ${template.maxDecimals} for ${template.id} template`,
      field: "decimals",
    });
  }

  return errors;
}

/**
 * Validate allowlist override
 */
export function validateAllowlistOverride(
  template: TokenTemplateDefinition,
  overrideValue?: boolean
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (overrideValue === undefined) {
    return errors;
  }

  // If template requires allowlist and it's not overridable
  if (template.requiresAllowlist && !template.allowlistOverridable && overrideValue === false) {
    errors.push({
      code: "ALLOWLIST_REQUIRED",
      message: `Allowlist is required for ${template.id} template and cannot be disabled`,
      field: "requiresAllowlist",
    });
  }

  return errors;
}

/**
 * Check if an extension is allowed for a template
 */
export function isExtensionAllowed(
  template: TokenTemplateDefinition,
  extension: TokenExtensionName
): boolean {
  const { required, defaultEnabled, available, incompatible } = template.extensions;

  // Check if incompatible
  if (incompatible.includes(extension)) {
    return false;
  }

  // Check if it's in any of the allowed lists
  return (
    required.includes(extension) ||
    defaultEnabled.includes(extension) ||
    available.includes(extension)
  );
}

/**
 * Validate that only allowed extensions are being enabled
 */
export function validateExtensionsAllowed(
  template: TokenTemplateDefinition,
  overrides?: ExtensionOverrides
): TemplateValidationError[] {
  const errors: TemplateValidationError[] = [];

  if (!overrides) {
    return errors;
  }

  const overrideEntries = Object.entries(overrides) as Array<[TokenExtensionName, unknown]>;

  for (const [extName, value] of overrideEntries) {
    // Skip if disabling (false values)
    if (value === false) {
      continue;
    }

    // Check if trying to enable an extension not allowed for this template
    if (!isExtensionAllowed(template, extName)) {
      errors.push({
        code: "EXTENSION_NOT_ALLOWED",
        message: `Extension '${extName}' is not available for ${template.id} template`,
        extension: extName,
      });
    }
  }

  return errors;
}

/**
 * Run all validations
 */
export function validateTemplateConfig(
  template: TokenTemplateDefinition,
  input: {
    decimals?: number;
    overrides?: {
      extensions?: ExtensionOverrides;
      requiresAllowlist?: boolean;
    };
  },
  enabledExtensions: TokenExtensionName[]
): TemplateValidationError[] {
  return [
    ...validateDecimals(template, input.decimals),
    ...validateRequiredExtensions(template, input.overrides?.extensions),
    ...validateAllowlistOverride(template, input.overrides?.requiresAllowlist),
    ...validateExtensionsAllowed(template, input.overrides?.extensions),
    ...validateExtensionCompatibility(template, enabledExtensions),
    ...validateExtensionAvailability(enabledExtensions),
  ];
}
