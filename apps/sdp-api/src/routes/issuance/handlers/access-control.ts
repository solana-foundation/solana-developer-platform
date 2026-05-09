import type { Token, TokenTemplate } from "@sdp/types";
import { AppError } from "@/lib/errors";
import type { AclMode } from "@/services/mosaic/types";

type TokenAccessControlShape = Pick<Token, "template" | "requiresAllowlist">;

const BLOCKLIST_TEMPLATES = new Set<TokenTemplate>(["stablecoin", "tokenized-security"]);

export type TokenAccessControlMode = AclMode | "disabled";

export function supportsBlocklistAccessControl(template: TokenTemplate): boolean {
  return BLOCKLIST_TEMPLATES.has(template);
}

export function getTokenAccessControlMode(token: TokenAccessControlShape): TokenAccessControlMode {
  if (token.requiresAllowlist) {
    return "allowlist";
  }

  if (supportsBlocklistAccessControl(token.template)) {
    return "blocklist";
  }

  return "disabled";
}

export function getMosaicAclMode(token: TokenAccessControlShape): AclMode | undefined {
  const mode = getTokenAccessControlMode(token);
  return mode === "disabled" ? undefined : mode;
}

export function shouldEnableOnChainAcl(
  token: TokenAccessControlShape,
  network: string | undefined
): boolean {
  const mode = getTokenAccessControlMode(token);
  if (mode === "disabled") return false;
  // Denylist enforcement always runs on-chain when supported. Allowlist enforcement
  // is mainnet-only because the mint flow does not yet add destinations to the
  // on-chain allowlist; minting to a non-allowlisted wallet otherwise fails at the
  // permissionless-thaw step (Token-2022 0x11 / AccountFrozen).
  if (mode === "blocklist") return true;
  return network === "mainnet-beta";
}

export function assertDestinationAllowedByControlList(args: {
  token: TokenAccessControlShape;
  destination: string;
  isOnControlList: boolean;
}): void {
  const mode = getTokenAccessControlMode(args.token);

  if (mode === "allowlist" && !args.isOnControlList) {
    throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
  }

  if (mode === "blocklist" && args.isOnControlList) {
    throw new AppError("ON_TOKEN_BLOCKLIST", "Destination address is on the denylist");
  }
}
