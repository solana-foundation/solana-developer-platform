/**
 * SPC gateway JSON-RPC client.
 *
 * The SPC gateway (`:8899`) speaks a SUBSET of Solana JSON-RPC (sendTransaction,
 * getLatestBlockhash, getAccountInfo, getTokenAccountBalance, getSignaturesForAddress,
 * getTransaction, ...). It is not a full validator, so unsupported methods
 * (e.g. `getVersion`) return "Method not found" — don't call them.
 *
 * Because it is Solana-JSON-RPC-compatible, we reuse `@sdp/rpc`'s Kit client,
 * just re-pointed at the gateway URL. The engine passes a structural env in
 * (never `process.env`), the same discipline as `config.ts`.
 */

import type { RpcEnv } from "@sdp/rpc";
import { createRpc, getAccountInfo, type SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export interface GatewayClientOptions {
  /**
   * Extra request headers for the gateway. JWT-gated methods take
   * `{ Authorization: \`Bearer \${token}\` }` here; `Authorization` is permitted by
   * `@sdp/rpc`'s header policy.
   */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Build a Solana-Kit RPC client pointed at the SPC gateway. This is `@sdp/rpc`'s
 * standard client with the URL overridden; every read/write helper in
 * `@sdp/rpc/solana` works against the returned client.
 */
export function createChannelGatewayRpc(
  env: RpcEnv,
  gatewayUrl: string,
  options?: GatewayClientOptions
): SolanaRpc {
  return createRpc(env, { rpcUrl: gatewayUrl, headers: options?.headers });
}

/** A channel token-account balance as reported by the gateway. */
export interface ChannelTokenAccountBalance {
  /** Raw base-unit amount (string to stay JSON- and precision-safe). */
  amount: string;
  /** Mint decimals reported by the gateway. */
  decimals: number;
  /** Human-readable amount string (prefer `amount` for arithmetic). */
  uiAmountString: string;
}

/** Result of reading an owner's channel token balance. */
export interface ChannelTokenBalanceResult {
  /** The derived associated-token account that was probed on the channel. */
  tokenAccount: Address;
  /**
   * The balance, or `null` when the account does not exist on the channel yet
   * (a never-credited owner) — callers treat `null` as an effective zero.
   */
  balance: ChannelTokenAccountBalance | null;
}

/**
 * Read an owner's channel token balance for `mint`. Channel token accounts derive
 * under the CLASSIC Token program, not Token-2022, so its program id is
 * used as the ATA `tokenProgram` seed. Returns `balance: null` (not an error) when
 * the owner has no token account on the channel yet.
 */
export async function getChannelTokenBalance(
  rpc: SolanaRpc,
  owner: Address,
  mint: Address
): Promise<ChannelTokenBalanceResult> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // Disambiguate "no account" from a real RPC failure up front: a missing ATA is
  // an expected zero balance, whereas getTokenAccountBalance would throw for it.
  const account = await getAccountInfo(rpc, tokenAccount);
  if (account === null) {
    return { tokenAccount, balance: null };
  }

  const { value } = await rpc.getTokenAccountBalance(tokenAccount).send();
  return {
    tokenAccount,
    balance: {
      amount: value.amount,
      decimals: value.decimals,
      uiAmountString: value.uiAmountString,
    },
  };
}
