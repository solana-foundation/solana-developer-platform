/**
 * The amounts demo mode starts each Payments and Issuance form with, so a flow can be walked straight to its
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
  /** New supply minted to the signing wallet, well inside every sample token's cap. */
  mint: "1000",
  /** Supply burned from the signing wallet, well inside every sample token's issued supply. */
  burn: "100",
  /** Tokens moved by force transfer, and burned by force burn. */
  seize: "50",
  forceBurn: "25",
} as const;

/** The memos and reasons demo mode starts Issuance's operations with. */
export const DEMO_PREFILL_MEMOS = {
  mint: "Issued to Treasury",
  burn: "Redeemed from Treasury",
  seize: "Recovery transfer",
  forceBurn: "Recovery burn",
  freeze: "Under compliance review",
} as const;
