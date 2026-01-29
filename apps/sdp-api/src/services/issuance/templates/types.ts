/**
 * Template Service Internal Types
 */

import type {
  ExtensionImplementationStatus,
  ExtensionOverrides,
  TokenExtensionName,
  TokenExtensionsConfig,
  TokenTemplate,
} from "@sdp/types";

/**
 * Extension status registry - tracks implementation state of each extension
 */
export interface ExtensionStatusRegistry {
  [key: string]: {
    status: ExtensionImplementationStatus;
    enabled: boolean;
    description: string;
  };
}

/**
 * Resolved token configuration after applying template + overrides
 */
export interface ResolvedTokenConfig {
  decimals: number;
  requiresAllowlist: boolean;
  extensions: TokenExtensionsConfig;
  template: TokenTemplate;
}

/**
 * Template resolution input
 */
export interface TemplateResolutionInput {
  template?: TokenTemplate;
  decimals?: number;
  requiresAllowlist?: boolean;
  overrides?: {
    extensions?: ExtensionOverrides;
    requiresAllowlist?: boolean;
  };
  /** Legacy: direct extensions (backward compatibility) */
  extensions?: TokenExtensionsConfig;
}

/**
 * Validation error for template resolution
 */
export interface TemplateValidationError {
  code: string;
  message: string;
  field?: string;
  extension?: TokenExtensionName;
}

/**
 * Template resolution result
 */
export type TemplateResolutionResult =
  | { success: true; config: ResolvedTokenConfig }
  | { success: false; errors: TemplateValidationError[] };
