import { AppError } from "@/lib/errors";
import type { AclMode } from "@/services/mosaic/types";
import type { Token, TokenTemplate } from "@sdp/types";

type TokenAccessControlShape = Pick<Token, "template" | "requiresAllowlist">;

const BLOCKLIST_TEMPLATES = new Set<TokenTemplate>(["stablecoin", "tokenized-security"]);

export type TokenAccessControlMode = AclMode | "disabled";

export function supportsBlocklistAccessControl(template: TokenTemplate): boolean {
  return BLOCKLIST_TEMPLATES.has(template);
}

export function getTokenAccessControlMode(
  token: TokenAccessControlShape
): TokenAccessControlMode {
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
  return network === "mainnet-beta" && getTokenAccessControlMode(token) !== "disabled";
}

export function assertDestinationAllowedByControlList(args: {
  token: TokenAccessControlShape;
  destination: string;
  isListed: boolean;
}): void {
  const mode = getTokenAccessControlMode(args.token);

  if (mode === "allowlist" && !args.isListed) {
    throw new AppError("NOT_ON_TOKEN_ALLOWLIST", "Destination address is not on the allowlist");
  }

  if (mode === "blocklist" && args.isListed) {
    throw new AppError("ON_TOKEN_BLOCKLIST", "Destination address is on the denylist");
  }
}
