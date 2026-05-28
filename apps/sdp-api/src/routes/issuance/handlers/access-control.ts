import type { Token, TokenTemplate } from "@sdp/types";
import { AppError } from "@/lib/errors";
import type { AclMode } from "@/services/mosaic/types";

type TokenAccessControlShape = Pick<Token, "template" | "requiresAllowlist">;
type TokenWithAblList = TokenAccessControlShape & Pick<Token, "ablListAddress">;

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

export function shouldEnableOnChainAcl(token: TokenAccessControlShape): boolean {
  return getTokenAccessControlMode(token) !== "disabled";
}

/**
 * Resolve the on-chain ABL list address that a mint destination must be added to
 * before MintTo can succeed.
 *
 * Returns the list address when the token is allowlist-mode + has on-chain ABL active
 * + has an `ablListAddress` populated. Returns null in any other case (blocklist,
 * disabled, or a token whose deploy never created an on-chain list).
 *
 * Callers prepend an `addWallet` sync to the on-chain list before invoking the mint
 * flow so the SDK's permissionless-thaw can succeed for a fresh destination.
 */
export function getOnChainAllowlistMutationForMint(token: TokenWithAblList): string | null {
  if (getTokenAccessControlMode(token) !== "allowlist") return null;
  if (!shouldEnableOnChainAcl(token)) return null;
  // Truthy check (not `??`) so an empty-string DB value is treated as "unset"
  // and we honor the documented null-when-no-list contract.
  return token.ablListAddress || null;
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
