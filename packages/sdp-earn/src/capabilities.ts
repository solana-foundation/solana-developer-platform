import type {
  EarnPortfolioWalletProvider,
  EarnVaultProvider,
  EarnWithdrawalApprovalProvider,
} from "./types";

/**
 * `satisfies` pins this list to the capability's method names: renaming a
 * contract method without updating the guard is a compile error, so the guard
 * can never silently report a partial implementation as supported.
 */
const PORTFOLIO_WALLET_METHODS = [
  "createPortfolioWallet",
  "getPortfolioWallet",
  "updatePortfolioStrategy",
  "getPortfolioYield",
  "listPortfolioDeposits",
  "previewPortfolioWithdrawal",
  "createPortfolioWithdrawal",
  "getPortfolioWithdrawal",
  "createPortfolioAddressBookEntry",
] as const satisfies readonly Exclude<keyof EarnPortfolioWalletProvider, keyof EarnVaultProvider>[];

/**
 * Capability discovery for the optional portfolio-wallet contract. Callers
 * (route handlers, crons) hold an `EarnVaultProvider` from the registry and
 * narrow with this guard instead of matching provider ids, so enabling the
 * capability for a new provider is implementing the methods — no dispatch
 * edits. All-or-nothing: a client exposing only some methods stays unsupported
 * rather than failing halfway through a wallet flow.
 */
export function supportsPortfolioWallets(
  client: EarnVaultProvider
): client is EarnPortfolioWalletProvider {
  const candidate = client as Partial<Record<(typeof PORTFOLIO_WALLET_METHODS)[number], unknown>>;
  return PORTFOLIO_WALLET_METHODS.every((method) => typeof candidate[method] === "function");
}

const WITHDRAWAL_APPROVAL_METHODS = [
  // biome-ignore lint/security/noSecrets: capability method name, not a secret.
  "listPendingWithdrawalApprovals",
  // biome-ignore lint/security/noSecrets: capability method name, not a secret.
  "createWithdrawalApprovalRequest",
  // biome-ignore lint/security/noSecrets: capability method name, not a secret.
  "submitWithdrawalApprovalVote",
] as const satisfies readonly Exclude<
  keyof EarnWithdrawalApprovalProvider,
  keyof EarnVaultProvider
>[];

/**
 * Capability discovery for the optional withdrawal-approval contract — same
 * all-or-nothing method-presence rule as `supportsPortfolioWallets`. Kept
 * separate from the portfolio-wallet capability: a provider can manage
 * portfolio wallets without gating payouts on customer approval, and folding
 * these methods into that guard would retroactively unsupport such providers.
 */
export function supportsWithdrawalApprovals(
  client: EarnVaultProvider
): client is EarnWithdrawalApprovalProvider {
  const candidate = client as Partial<
    Record<(typeof WITHDRAWAL_APPROVAL_METHODS)[number], unknown>
  >;
  return WITHDRAWAL_APPROVAL_METHODS.every((method) => typeof candidate[method] === "function");
}
