/**
 * Template Service
 *
 * Exposes issuance templates without SDP-specific configuration.
 */

import type { TokenTemplateInfo } from "@sdp/types";
import { normalizeTemplateId, resolveTemplateConfig, TEMPLATE_DEFINITIONS } from "./definitions";

const TEMPLATE_IDS = Object.keys(TEMPLATE_DEFINITIONS) as Array<keyof typeof TEMPLATE_DEFINITIONS>;
const PUBLIC_TEMPLATE_IDS = TEMPLATE_IDS.filter((id) => id !== "arcade");
const PUBLIC_TEMPLATE_ID_SET = new Set<string>(PUBLIC_TEMPLATE_IDS);

function buildTemplateInfo(templateId: keyof typeof TEMPLATE_DEFINITIONS): TokenTemplateInfo {
  const template = TEMPLATE_DEFINITIONS[templateId];
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

export function listTemplates(): TokenTemplateInfo[] {
  return PUBLIC_TEMPLATE_IDS.map(buildTemplateInfo);
}

export function getTemplateInfo(id: string): TokenTemplateInfo | undefined {
  const normalized = normalizeTemplateId(id);
  const template = TEMPLATE_DEFINITIONS[normalized];
  if (!template) {
    return undefined;
  }
  return buildTemplateInfo(normalized);
}

export function getPublicTemplateInfo(id: string): TokenTemplateInfo | undefined {
  const normalized = normalizeTemplateId(id);
  if (!PUBLIC_TEMPLATE_ID_SET.has(normalized)) {
    return undefined;
  }
  return buildTemplateInfo(normalized);
}

export { normalizeTemplateId, resolveTemplateConfig };
