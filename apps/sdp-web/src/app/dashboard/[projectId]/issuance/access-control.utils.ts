import type { Token, TokenTemplate } from "@sdp/types/tokens";

type AccessControlTokenShape = Pick<Token, "template" | "requiresAllowlist">;

const BLOCKLIST_TEMPLATES = new Set<TokenTemplate>(["stablecoin", "tokenized-security"]);

export type AccessControlMode = "allowlist" | "blocklist" | "disabled";

function supportsBlocklistMode(template: TokenTemplate): boolean {
  return BLOCKLIST_TEMPLATES.has(template);
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
