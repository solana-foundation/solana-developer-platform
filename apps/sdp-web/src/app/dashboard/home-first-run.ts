import type { CustodyWalletTokenBalance } from "@sdp/types";
import { countHeldTokens } from "./home-balance-breakdown";

/**
 * Which hero the home page owes this organization.
 *
 * `provisioned_empty` exists because onboarding does not merely record a provider
 * choice — completing it provisions a wallet before it finishes. Gating the
 * first-run panel on `wallets.length === 0` therefore never fired for a freshly
 * onboarded organization: it already had one empty wallet, fell through to the
 * populated hero, and rendered $0.00 as the first thing it ever saw.
 *
 * `hasPricedValue` separates "the feed answered, and it said zero" from "nothing
 * here has a price feed at all". An organization holding only its own issued
 * tokens is the latter, and a currency figure there is a false zero rather than a
 * balance.
 */
export type HomeHeroState =
  | { kind: "first_run" }
  | { kind: "provisioned_empty" }
  | { kind: "populated"; hasPricedValue: boolean };

export function resolveHomeHeroState(input: {
  walletCount: number;
  balances: CustodyWalletTokenBalance[];
  totalBalance: number | null;
  balancesUnavailable: boolean;
}): HomeHeroState {
  // An organization that holds nothing and one whose feeds just failed arrive
  // here looking identical — the page defaults the aggregate to `[]` and the
  // wallet count to zero when the requests do not succeed. Only the first is
  // genuinely empty, and the page suppresses this flag when the wallet request
  // succeeded with an empty list, so an unavailable feed means neither the
  // count nor the balances can be trusted. It has to win before the first-run
  // check: classifying the failure as `first_run` or `provisioned_empty` would
  // tell an established organization to get started and silently drop the
  // error only the populated hero can report.
  if (input.balancesUnavailable) {
    return { kind: "populated", hasPricedValue: input.totalBalance !== null };
  }

  if (input.walletCount === 0) {
    return { kind: "first_run" };
  }

  // Reuses the holdings rule the allocation card already applies to this same
  // data, so a spent token account that keeps its row at zero is not counted as
  // something held.
  if (countHeldTokens(input.balances) === 0) {
    return { kind: "provisioned_empty" };
  }

  return { kind: "populated", hasPricedValue: input.totalBalance !== null };
}
