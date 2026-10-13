import type { Address, GetAccountInfoApi, GetMultipleAccountsApi, Rpc } from "@solana/kit";
import { SdpWisdomTreeError } from "./errors";

/**
 * The one chain-read seam the builders consume. An interface rather than a raw
 * RPC client so unit tests inject a fake and stay offline (the repo rule), and
 * so every read shares one transport deadline.
 */
export interface WisdomTreeChainReader {
  /** The account's owner program and raw data, or null when it does not exist. */
  getAccount(accountAddress: Address): Promise<WisdomTreeChainAccount | null>;
  /** Several accounts in ONE request, in the order asked; null where one does not exist. */
  getAccounts(accountAddresses: readonly Address[]): Promise<(WisdomTreeChainAccount | null)[]>;
}

export interface WisdomTreeChainAccount {
  owner: string;
  data: Uint8Array;
}

/** The reads a `WisdomTreeChainReader` sends. */
export type WisdomTreeChainRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi>;

/**
 * The chain reader over `rpc`, mapping every read failure and unrecognized account shape to
 * `VAULT_UNREADABLE`.
 *
 * @param rpc - A client for the fund's cluster.
 * @returns The reader the builders and position reads consume.
 */
export function createWisdomTreeChainReader(rpc: WisdomTreeChainRpc): WisdomTreeChainReader {
  return {
    async getAccount(accountAddress) {
      let value: { owner: unknown; data: unknown } | null;
      try {
        const response = await rpc.getAccountInfo(accountAddress, { encoding: "base64" }).send();
        value = response.value;
      } catch (cause) {
        throw new SdpWisdomTreeError(
          "VAULT_UNREADABLE",
          `Failed to read account ${accountAddress}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause }
        );
      }
      return decodeAccount(accountAddress, value);
    },
    async getAccounts(accountAddresses) {
      let values: readonly ({ owner: unknown; data: unknown } | null)[];
      try {
        const response = await rpc
          .getMultipleAccounts([...accountAddresses], { encoding: "base64" })
          .send();
        values = response.value;
      } catch (cause) {
        throw new SdpWisdomTreeError(
          "VAULT_UNREADABLE",
          `Failed to read accounts ${accountAddresses.join(", ")}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause }
        );
      }
      if (values.length !== accountAddresses.length) {
        throw new SdpWisdomTreeError(
          "VAULT_UNREADABLE",
          `The RPC answered ${values.length} of ${accountAddresses.length} requested accounts.`
        );
      }
      return accountAddresses.map((accountAddress, index) =>
        decodeAccount(accountAddress, values[index] ?? null)
      );
    },
  };
}

function decodeAccount(
  accountAddress: Address,
  value: { owner: unknown; data: unknown } | null
): WisdomTreeChainAccount | null {
  if (value === null) {
    return null;
  }
  const encoded = Array.isArray(value.data) ? value.data[0] : undefined;
  if (typeof encoded !== "string" || typeof value.owner !== "string") {
    throw new SdpWisdomTreeError(
      "VAULT_UNREADABLE",
      `Account ${accountAddress} came back in an unrecognized RPC shape.`
    );
  }
  return { owner: value.owner, data: Uint8Array.from(Buffer.from(encoded, "base64")) };
}

/** Exact token-account balance in base units, from the raw 165-byte layout (amount is u64 LE at offset 64). */
export function tokenAccountBaseUnits(data: Uint8Array): bigint {
  if (data.length < 72) {
    throw new SdpWisdomTreeError(
      "VAULT_UNREADABLE",
      `Token account data is ${data.length} bytes — shorter than the token-account layout.`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getBigUint64(64, true);
}
