/**
 * Token Template Definitions
 *
 * Templates aligned with Mosaic SDK for consistent enterprise token creation.
 * Each template provides sensible defaults that can be customized via overrides.
 */

import type { ExtensionInfo, TokenExtensionName, TokenTemplateDefinition } from "@sdp/types";
import type { ExtensionStatusRegistry } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Extension Implementation Status
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extension status registry - tracks which extensions are implemented and enabled
 *
 * Feature flag pattern: Extensions can be "implemented" but disabled via feature flag.
 * This allows building CT support fully while keeping it disabled until ready.
 */
export const extensionStatus: ExtensionStatusRegistry = {
  confidentialTransfer: {
    status: "implemented",
    enabled: false, // Feature flag - flip to true when ready
    description: "Enables private balance transfers using zero-knowledge proofs",
  },
  transferFee: {
    status: "implemented",
    enabled: true,
    description: "Collects fees on token transfers",
  },
  interestBearing: {
    status: "implemented",
    enabled: true,
    description: "Allows tokens to accrue interest over time",
  },
  permanentDelegate: {
    status: "implemented",
    enabled: true,
    description: "Grants permanent transfer/burn authority to a delegate",
  },
  nonTransferable: {
    status: "implemented",
    enabled: true,
    description: "Makes tokens non-transferable (soulbound)",
  },
  defaultAccountState: {
    status: "implemented",
    enabled: true,
    description: "Sets default state for new token accounts (initialized or frozen)",
  },
  metadataPointer: {
    status: "implemented",
    enabled: true,
    description: "Points to on-chain metadata",
  },
  groupPointer: {
    status: "planned",
    enabled: false,
    description: "Groups related tokens together",
  },
};

/**
 * Get extension info for API responses
 */
export function getExtensionInfo(name: TokenExtensionName): ExtensionInfo {
  const info = extensionStatus[name];
  if (!info) {
    return {
      status: "planned",
      enabled: false,
      description: "Extension not yet supported",
    };
  }
  return info;
}

/**
 * Check if an extension is available for use
 */
export function isExtensionAvailable(name: TokenExtensionName): boolean {
  const info = extensionStatus[name];
  return info?.status === "implemented" && info.enabled;
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Definitions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stablecoin Template
 *
 * For USD-backed stablecoins and similar assets.
 * - 6 decimals (standard for stablecoins like USDC)
 * - Required allowlist for KYC compliance
 * - Default frozen state (accounts must be unfrozen after KYC)
 * - Permanent delegate for compliance/recovery operations
 * - Confidential transfer ready (feature-flagged)
 */
export const stablecoinTemplate: TokenTemplateDefinition = {
  id: "stablecoin",
  name: "Stablecoin",
  description: "USD-backed stablecoins with compliance controls and privacy features",
  decimals: 6,
  maxDecimals: 9,
  requiresAllowlist: true,
  allowlistOverridable: false,
  extensions: {
    required: ["defaultAccountState", "permanentDelegate"],
    defaultEnabled: ["confidentialTransfer"],
    available: ["transferFee"],
    incompatible: ["nonTransferable", "interestBearing"],
  },
  defaultExtensions: {
    defaultAccountState: "frozen",
    // permanentDelegate will be set to platform authority at deployment
  },
};

/**
 * RWA (Real World Asset) Template
 *
 * For tokenized real estate, commodities, and other physical assets.
 * - 8 decimals (allows fine-grained fractional ownership)
 * - Required allowlist for regulatory compliance
 * - Default frozen state
 * - Optional transfer fees for transaction tracking
 */
export const rwaTemplate: TokenTemplateDefinition = {
  id: "rwa",
  name: "Real World Asset",
  description: "Tokenized real estate, commodities, and physical assets with compliance controls",
  decimals: 8,
  maxDecimals: 9,
  requiresAllowlist: true,
  allowlistOverridable: false,
  extensions: {
    required: ["defaultAccountState", "permanentDelegate"],
    defaultEnabled: [],
    available: ["transferFee", "confidentialTransfer"],
    incompatible: ["nonTransferable"],
  },
  defaultExtensions: {
    defaultAccountState: "frozen",
  },
};

/**
 * Arcade Template
 *
 * For gaming tokens, rewards points, and non-financial assets.
 * - 0 decimals (whole units only, like arcade tokens)
 * - Optional allowlist (can be open or restricted)
 * - Default initialized state (ready to use immediately)
 * - No privacy features (not suitable for confidential transfers)
 */
export const arcadeTemplate: TokenTemplateDefinition = {
  id: "arcade",
  name: "Arcade Token",
  description: "Gaming tokens, rewards points, and non-financial assets",
  decimals: 0,
  maxDecimals: 9,
  requiresAllowlist: false,
  allowlistOverridable: true,
  extensions: {
    required: ["defaultAccountState", "permanentDelegate"],
    defaultEnabled: [],
    available: ["transferFee", "nonTransferable"],
    incompatible: ["confidentialTransfer", "interestBearing"],
  },
  defaultExtensions: {
    defaultAccountState: "initialized",
  },
};

/**
 * Tokenized Security Template
 *
 * For equity, bonds, and other securities.
 * - 8 decimals (standard for securities)
 * - Required allowlist (SEC/regulatory compliance)
 * - Default frozen state
 * - Interest-bearing option for bonds
 * - Confidential transfer ready
 */
export const tokenizedSecurityTemplate: TokenTemplateDefinition = {
  id: "tokenized_security",
  name: "Tokenized Security",
  description: "Equity, bonds, and regulated securities with full compliance controls",
  decimals: 8,
  maxDecimals: 9,
  requiresAllowlist: true,
  allowlistOverridable: false,
  extensions: {
    required: ["defaultAccountState", "permanentDelegate"],
    defaultEnabled: ["confidentialTransfer"],
    available: ["transferFee", "interestBearing"],
    incompatible: ["nonTransferable"],
  },
  defaultExtensions: {
    defaultAccountState: "frozen",
  },
};

/**
 * Custom Template
 *
 * Fully configurable template for advanced use cases.
 * - 9 decimals (Solana default)
 * - All settings configurable
 * - No required extensions
 */
export const customTemplate: TokenTemplateDefinition = {
  id: "custom",
  name: "Custom",
  description: "Fully configurable token with no preset extensions or requirements",
  decimals: 9,
  maxDecimals: 18,
  requiresAllowlist: false,
  allowlistOverridable: true,
  extensions: {
    required: [],
    defaultEnabled: [],
    available: [
      "confidentialTransfer",
      "transferFee",
      "interestBearing",
      "permanentDelegate",
      "nonTransferable",
      "defaultAccountState",
    ],
    incompatible: [],
  },
  defaultExtensions: {},
};

// ═══════════════════════════════════════════════════════════════════════════
// Template Registry
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All available templates indexed by ID
 */
export const templates: Record<string, TokenTemplateDefinition> = {
  stablecoin: stablecoinTemplate,
  rwa: rwaTemplate,
  arcade: arcadeTemplate,
  tokenized_security: tokenizedSecurityTemplate,
  custom: customTemplate,
};

/**
 * Get a template by ID
 */
export function getTemplate(id: string): TokenTemplateDefinition | undefined {
  return templates[id];
}

/**
 * Get all templates as an array
 */
export function getAllTemplates(): TokenTemplateDefinition[] {
  return Object.values(templates);
}
