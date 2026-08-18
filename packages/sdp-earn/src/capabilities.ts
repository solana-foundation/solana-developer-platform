import type {
  EarnLiveMetricsProvider,
  EarnPortfolioWalletProvider,
  EarnVaultDirectProvider,
  EarnVaultProvider,
  EarnVaultWithdrawProvider,
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

const VAULT_DIRECT_METHODS = [
  "buildVaultDeposit",
  "readVaultPositions",
] as const satisfies readonly Exclude<keyof EarnVaultDirectProvider, keyof EarnVaultProvider>[];

/**
 * Capability discovery for the optional vault-direct contract — same
 * all-or-nothing method-presence rule as the guards above.
 *
 * Deliberately DISJOINT from `supportsPortfolioWallets`: the two describe
 * opposite money models. A portfolio provider hands SDP a custodied wallet
 * address to fund; a vault-direct provider has no such address at all, and the
 * one it superficially resembles — the vault's own account — destroys funds sent
 * to it. Nothing should ever be true of both, and a provider implementing both
 * sets of methods is a bug in that client, not a richer provider.
 */
export function supportsVaultDirect(client: EarnVaultProvider): client is EarnVaultDirectProvider {
  const candidate = client as Partial<Record<(typeof VAULT_DIRECT_METHODS)[number], unknown>>;
  return VAULT_DIRECT_METHODS.every((method) => typeof candidate[method] === "function");
}

const VAULT_WITHDRAW_METHODS = ["buildVaultWithdrawal"] as const satisfies readonly Exclude<
  keyof EarnVaultWithdrawProvider,
  keyof EarnVaultDirectProvider
>[];

/**
 * Capability discovery for the money-OUT half, asked SEPARATELY from money-in.
 *
 * `buildVaultDeposit` proves a provider can build one transaction; an exit may
 * legitimately need several, one per reserve the vault draws from, and getting
 * that batching right is the hard part. Keeping the question separate is what
 * stops "this provider supports vault deposits" from silently also asserting
 * "…and can build a correctly sized exit" — the exact conflation that let an
 * unsized single-batch withdrawal plan look shippable.
 *
 * A provider that answers false here has no SDP exit route. That is a statement
 * about SDP's plumbing, never about the customer's right to their money: the
 * shares are in their own wallet and Kamino's own UI can always redeem them.
 */
export function supportsVaultWithdraw(
  client: EarnVaultProvider
): client is EarnVaultWithdrawProvider {
  if (!supportsVaultDirect(client)) return false;
  const candidate = client as Partial<Record<(typeof VAULT_WITHDRAW_METHODS)[number], unknown>>;
  return VAULT_WITHDRAW_METHODS.every((method) => typeof candidate[method] === "function");
}

const LIVE_METRICS_METHODS = ["listStrategyMetrics"] as const satisfies readonly Exclude<
  keyof EarnLiveMetricsProvider,
  keyof EarnVaultProvider
>[];

/**
 * Capability discovery for the optional live-metrics contract — same
 * method-presence rule as the guards above. Opting in is a promise about COST
 * as much as capability: the refresh pass runs an order of magnitude more often
 * than the catalogue sync, so a provider should only implement it when its
 * whole shelf's figures come back in a call or two.
 */
export function supportsLiveMetrics(client: EarnVaultProvider): client is EarnLiveMetricsProvider {
  const candidate = client as Partial<Record<(typeof LIVE_METRICS_METHODS)[number], unknown>>;
  return LIVE_METRICS_METHODS.every((method) => typeof candidate[method] === "function");
}
