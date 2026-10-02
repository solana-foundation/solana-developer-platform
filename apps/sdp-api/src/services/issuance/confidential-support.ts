import { AppError } from "@/lib/errors";

/**
 * Whether a token can carry confidential balances at all.
 *
 * The ConfidentialTransferMint extension is set at InitializeMint and can never
 * be added afterwards, so this is a permanent property of the token — a refusal
 * here is not something a later configure call could fix.
 */

interface ConfidentialCapableToken {
  template?: string | null;
  extensions?: { confidentialTransfers?: unknown; confidentialMintBurn?: unknown } | null;
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

/**
 * Whether a token's supply lives only as an ElGamal ciphertext.
 *
 * Unlike confidential balances, no template implies this: `ConfidentialMintBurn`
 * is offered on the custom template alone and only when explicitly configured,
 * so the stored config is the whole answer. It is also creation-only, and it
 * takes the plaintext supply away for good — plaintext mint, burn and
 * force-burn, and confidential deposit and withdraw, are all refused on such a
 * mint by Token-2022 itself.
 */
export function tokenHasConfidentialMintBurn(token: ConfidentialCapableToken): boolean {
  return Boolean(token.extensions?.confidentialMintBurn);
}

/**
 * Refuse an operation that needs a plaintext balance on a mint that has none.
 *
 * Token-2022 rejects `ConfidentialDeposit`, `ConfidentialWithdraw` and every
 * plaintext mint or burn on a `ConfidentialMintBurn` mint, and the mosaic
 * builders fail fast before building a transaction. Checking here turns that
 * into a 400 naming the confidential counterpart, before any RPC work — and
 * covers the handlers that would otherwise surface it as a 500.
 *
 * @param operation - Named in the message, e.g. "minting" or "withdrawing to a
 *   public balance".
 */
export function assertTokenNotConfidentialMintBurn(
  token: ConfidentialCapableToken,
  operation: string
): void {
  if (!tokenHasConfidentialMintBurn(token)) {
    return;
  }
  throw new AppError(
    "CONFIDENTIAL_MINT_BURN_CONVERSION",
    `This token keeps its whole supply encrypted, so ${operation} is not available on it.`,
    { hint: "Use the confidential mint and burn operations instead." }
  );
}
