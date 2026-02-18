/**
 * Template Service
 *
 * Exposes issuance templates without SDP-specific configuration.
 */

import type { TokenTemplateInfo } from "@sdp/types";
import { TEMPLATE_DEFINITIONS, normalizeTemplateId, resolveTemplateConfig } from "./definitions";

const TEMPLATE_IDS = Object.keys(TEMPLATE_DEFINITIONS);

export function listTemplates(): TokenTemplateInfo[] {
  return TEMPLATE_IDS.map((id) => {
    const template = TEMPLATE_DEFINITIONS[id as keyof typeof TEMPLATE_DEFINITIONS];
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      decimals: template.decimals,
      maxDecimals: template.maxDecimals,
      requiresAllowlist: template.requiresAllowlist,
      allowlistOverridable: template.allowlistOverridable,
      requiredExtensions: template.extensions.required,
      availableExtensions: template.extensions.available,
      defaultExtensions: template.defaultExtensions,
    };
  });
}

export function getTemplateInfo(id: string): TokenTemplateInfo | undefined {
  const normalized = normalizeTemplateId(id);
  const template = TEMPLATE_DEFINITIONS[normalized];
  if (!template) {
    return undefined;
  }
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    decimals: template.decimals,
    maxDecimals: template.maxDecimals,
    requiresAllowlist: template.requiresAllowlist,
    allowlistOverridable: template.allowlistOverridable,
    requiredExtensions: template.extensions.required,
    availableExtensions: template.extensions.available,
    defaultExtensions: template.defaultExtensions,
  };
}

export { normalizeTemplateId, resolveTemplateConfig };
