import type { Token, TokenTemplate } from "@sdp/types";

type AccessControlTokenShape = Pick<Token, "template" | "requiresAllowlist">;

const BLOCKLIST_TEMPLATES = new Set<TokenTemplate>(["stablecoin", "tokenized-security"]);

export type AccessControlMode = "allowlist" | "blocklist" | "disabled";

export function supportsBlocklistMode(template: TokenTemplate): boolean {
  return BLOCKLIST_TEMPLATES.has(template);
}

export function getDefaultAccessControlMode(template: TokenTemplate): AccessControlMode {
  switch (template) {
    case "stablecoin":
      return "blocklist";
    case "tokenized-security":
      return "allowlist";
    default:
      return "disabled";
  }
}

export function getTokenAccessControlMode(token: AccessControlTokenShape): AccessControlMode {
  if (token.requiresAllowlist) {
    return "allowlist";
  }

  if (supportsBlocklistMode(token.template)) {
    return "blocklist";
  }

  return "disabled";
}

export function hasAccessControlList(mode: AccessControlMode): boolean {
  return mode !== "disabled";
}
