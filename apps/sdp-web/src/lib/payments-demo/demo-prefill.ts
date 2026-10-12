/**
 * The amounts demo mode starts each Payments form with, so a flow can be walked straight to its
 * end. Each fits every provider and every sample wallet: a deposit clears the highest provider
 * minimum (MoonPay's 20 USD), and a payout or send is well inside the wallets' balances.
 */
export const DEMO_PREFILL_AMOUNTS = {
  /** Fiat into a wallet, in the pair's currency. */
  deposit: "250",
  /** Crypto out to a bank account. */
  payout: "100",
  /** Crypto to an address. */
  send: "25",
  /** Each recipient's share of a batch. */
  batchRecipient: "50",
  /** What a payment request asks for. */
  request: "120",
  /** Each run of a schedule. */
  schedule: "500",
} as const;
