import { SdpKaminoError } from "./errors";

type ParsedTokenAccount = {
  account?: {
    data?: {
      parsed?: {
        info?: {
          tokenAmount?: {
            amount?: unknown;
          };
        };
      };
    };
  };
};

/**
 * Sum every matching token account from its exact raw amount.
 *
 * The RPC filter already selected this mint, so each returned account is part
 * of the owner's balance. If even one result is malformed, returning the sum of
 * the readable subset would make a confident but false claim about custody.
 */
export function sumRawTokenAccountBaseUnits(entries: unknown): bigint {
  if (!Array.isArray(entries)) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino share-token RPC response did not contain an account list"
    );
  }

  let total = 0n;
  for (const [index, entry] of entries.entries()) {
    const raw = (entry as ParsedTokenAccount | null)?.account?.data?.parsed?.info?.tokenAmount
      ?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
      throw new SdpKaminoError(
        "VAULT_UNREADABLE",
        `Kamino share-token account ${index} did not contain an exact raw amount`
      );
    }
    total += BigInt(raw);
  }
  return total;
}
