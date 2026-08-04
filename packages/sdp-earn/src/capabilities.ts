import type { EarnPortfolioWalletProvider, EarnVaultProvider } from "./types";

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
