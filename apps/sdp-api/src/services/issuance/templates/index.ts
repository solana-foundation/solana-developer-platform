/**
 * Template Service (Mosaic-backed)
 *
 * Exposes the Mosaic template surface without SDP-specific configuration.
 */

import type { TokenTemplate, TokenTemplateInfo } from "@sdp/types";

const MOSAIC_TEMPLATE_IDS = [
  "stablecoin",
  "arcade",
  "tokenized-security",
  "custom",
] as const satisfies readonly TokenTemplate[];

const toDisplayName = (id: string) =>
  id
    .split("-")
    .map((part) => (part.length ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");

const normalizeTemplateId = (id: string): TokenTemplate => {
  if (id === "tokenized_security" || id === "rwa") {
    return "tokenized-security";
  }
  return id as TokenTemplate;
};

export function listTemplates(): TokenTemplateInfo[] {
  return MOSAIC_TEMPLATE_IDS.map((id) => ({
    id,
    name: toDisplayName(id),
  }));
}

export function getTemplateInfo(id: string): TokenTemplateInfo | undefined {
  const normalized = normalizeTemplateId(id);
  if (!MOSAIC_TEMPLATE_IDS.includes(normalized)) {
    return undefined;
  }
  return {
    id: normalized,
    name: toDisplayName(normalized),
  };
}
