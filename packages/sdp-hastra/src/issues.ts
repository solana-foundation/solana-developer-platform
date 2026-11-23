import { SdpHastraError, type SdpHastraErrorCode } from "./errors";
import type { HastraState } from "./state";

export function depositBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues = stakeBlockingIssues(state);
  if (state.mintConfig.paused) {
    issues.unshift({
      code: "HASTRA_MINT_PAUSED",
      message: "Hastra's USDC to wYLDS mint is paused.",
    });
  }
  if (state.depositVaultFrozen) {
    issues.push({
      code: "HASTRA_DEPOSIT_VAULT_FROZEN",
      message: "Hastra's USDC deposit vault is frozen.",
    });
  }
  return issues;
}

export function stakeBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  if (state.stakeConfig.paused) {
    issues.push({ code: "HASTRA_STAKE_PAUSED", message: "Hastra's PRIME staking pool is paused." });
  }
  if (state.stakeVaultFrozen) {
    issues.push({
      code: "HASTRA_STAKE_VAULT_FROZEN",
      message: "Hastra's wYLDS stake vault is frozen.",
    });
  }
  if (state.stakePrice.price <= 0n || state.stakePrice.timestamp <= 0n) {
    issues.push({
      code: "HASTRA_PRICE_UNAVAILABLE",
      message: "Hastra's PRIME/wYLDS redemption rate is not initialized.",
    });
  } else {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    if (now - state.stakePrice.timestamp > state.stakePrice.maxStaleness) {
      issues.push({
        code: "HASTRA_PRICE_STALE",
        message: "Hastra's PRIME/wYLDS redemption rate is stale.",
      });
    }
  }
  return issues;
}

/** What blocks `request_redeem` itself, whichever source feeds it. */
export function parRequestBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const issues: { code: string; message: string }[] = [];
  if (state.mintConfig.paused) {
    issues.push({
      code: "HASTRA_MINT_PAUSED",
      message: "Hastra's wYLDS redemption request program is paused.",
    });
  }
  if (state.redeemVaultFrozen) {
    issues.push({
      code: "HASTRA_REDEEM_VAULT_FROZEN",
      message: "Hastra's operator USDC redemption vault is frozen.",
    });
  }
  return issues;
}

/** The PRIME source also redeems through the stake program first. */
export function parBlockingIssues(state: HastraState): { code: string; message: string }[] {
  const request = parRequestBlockingIssues(state);
  const paused = request.filter((issue) => issue.code === "HASTRA_MINT_PAUSED");
  const rest = request.filter((issue) => issue.code !== "HASTRA_MINT_PAUSED");
  return [...paused, ...stakeBlockingIssues(state), ...rest];
}

export function assertNoBlockingIssues(
  issues: readonly { code: string; message: string }[],
  code: SdpHastraErrorCode,
  operation: string
): void {
  const issue = issues[0];
  if (issue) throw new SdpHastraError(code, `${operation} is unavailable: ${issue.message}`);
}
