/**
 * Whether a token can carry confidential balances at all.
 *
 * The ConfidentialTransferMint extension is set at InitializeMint and can never
 * be added afterwards, so this is a permanent property of the token — a refusal
 * here is not something a later configure call could fix.
 */

interface ConfidentialCapableToken {
  template?: string | null;
  extensions?: { confidentialTransfers?: unknown } | null;
}

export function tokenHasConfidentialBalances(token: ConfidentialCapableToken): boolean {
  // The stablecoin and tokenized-security templates always initialize the mint
  // with the extension, whether or not it was requested, so their stored config
  // says nothing either way. Custom and arcade mints only have it when it was
  // explicitly configured at creation.
  if (token.template === "stablecoin" || token.template === "tokenized-security") {
    return true;
  }
  return Boolean(token.extensions?.confidentialTransfers);
}
