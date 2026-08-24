import { type Address, address } from "@solana/kit";
import { SdpKaminoError } from "./errors";

type ParsedTokenAccount = {
  pubkey?: unknown;
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

export interface ShareTokenAccountBalance {
  address: Address;
  amount: bigint;
}

function readRawAmount(entry: unknown, index: number): bigint {
  const raw = (entry as ParsedTokenAccount | null)?.account?.data?.parsed?.info?.tokenAmount
    ?.amount;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      `Kamino share-token account ${index} did not contain an exact raw amount`
    );
  }
  return BigInt(raw);
}

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
    total += readRawAmount(entry, index);
  }
  return total;
}

/** Parse every matching account address together with its exact raw balance. */
export function parseShareTokenAccountBalances(entries: unknown): ShareTokenAccountBalance[] {
  if (!Array.isArray(entries)) {
    throw new SdpKaminoError(
      "VAULT_UNREADABLE",
      "Kamino share-token RPC response did not contain an account list"
    );
  }

  return entries.map((entry, index) => {
    const rawAddress = (entry as ParsedTokenAccount | null)?.pubkey;
    if (typeof rawAddress !== "string") {
      throw new SdpKaminoError(
        "VAULT_UNREADABLE",
        `Kamino share-token account ${index} did not contain an address`
      );
    }
    try {
      return { address: address(rawAddress), amount: readRawAmount(entry, index) };
    } catch (cause) {
      if (cause instanceof SdpKaminoError) throw cause;
      throw new SdpKaminoError(
        "VAULT_UNREADABLE",
        `Kamino share-token account ${index} contained an invalid address`,
        { cause }
      );
    }
  });
}
