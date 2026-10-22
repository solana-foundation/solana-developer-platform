import type { SignatureInfo } from "@sdp/rpc/solana";
import { getBase58Decoder } from "@solana/codecs";
import { type Address, address, type Commitment, type Signature, signature } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { JsonRpcResult } from "@/test/helpers/cluster-rpc";

/**
 * Bytes of the given length that are distinct for every index.
 *
 * @param length - The byte length.
 * @param index - Any non-negative integer up to 2^32 - 1.
 * @returns The bytes, with `index` big-endian in the first four.
 */
function syntheticBytes(length: number, index: number): Uint8Array {
  const bytes = new Uint8Array(length).fill(7);
  new DataView(bytes.buffer).setUint32(0, index);
  return bytes;
}

/**
 * A well-formed synthetic transaction signature, distinct for every index.
 *
 * @param index - Any non-negative integer up to 2^32 - 1.
 * @returns The signature.
 */
export function syntheticSignature(index: number): Signature {
  return signature(getBase58Decoder().decode(syntheticBytes(64, index)));
}

/**
 * A well-formed synthetic account address, distinct for every index.
 *
 * @param index - Any non-negative integer up to 2^32 - 1.
 * @returns The address.
 */
export function syntheticAddress(index: number): Address {
  return address(getBase58Decoder().decode(syntheticBytes(32, index)));
}

/**
 * A `getSignaturesForAddress` entry as `@sdp/rpc/solana` returns it, distinct for every index.
 *
 * @param index - Any non-negative integer up to 2^32 - 1; also the entry's slot.
 * @param confirmationStatus - The commitment the history reports the signature at.
 * @returns The history entry.
 */
export function signatureHistoryEntry(
  index: number,
  confirmationStatus: Commitment
): SignatureInfo {
  return {
    signature: syntheticSignature(index),
    slot: BigInt(index),
    blockTime: 1700000000n,
    err: null,
    confirmationStatus,
  };
}

/** A token amount as the RPC's `jsonParsed` encoding serves it. */
interface ParsedTokenAmount {
  amount: string;
  decimals: number;
  uiAmountString: string;
}

/**
 * The `uiTokenAmount` / `tokenAmount` object the RPC serves for a token amount.
 *
 * @param tokenAmount - The raw amount, decimals and display amount.
 * @returns The JSON value.
 */
function uiTokenAmount(tokenAmount: ParsedTokenAmount): JsonRpcResult {
  return {
    amount: tokenAmount.amount,
    decimals: tokenAmount.decimals,
    uiAmount: Number(tokenAmount.uiAmountString),
    uiAmountString: tokenAmount.uiAmountString,
  };
}

/**
 * A top-level `jsonParsed` system-program `transfer` instruction; `lamports` is a JSON number, as
 * agave serves it.
 *
 * @param transfer - The source, destination and lamports moved.
 * @param transfer.source - The paying account.
 * @param transfer.destination - The receiving account.
 * @param transfer.lamports - The lamports moved.
 * @returns The instruction JSON.
 */
export function parsedSystemTransfer(transfer: {
  source: string;
  destination: string;
  lamports: number;
}): JsonRpcResult {
  return {
    program: "system",
    programId: SYSTEM_PROGRAM_ADDRESS,
    parsed: {
      type: "transfer",
      info: {
        source: transfer.source,
        destination: transfer.destination,
        lamports: transfer.lamports,
      },
    },
    stackHeight: 1,
  };
}

/**
 * A top-level `jsonParsed` spl-token `transferChecked` instruction; `tokenAmount.decimals` is a
 * JSON number, as agave serves it.
 *
 * @param transfer - The token accounts, mint, authority and amount.
 * @param transfer.source - The source token account.
 * @param transfer.destination - The destination token account.
 * @param transfer.mint - The token mint.
 * @param transfer.authority - The source account's authority.
 * @param transfer.tokenAmount - The amount moved.
 * @returns The instruction JSON.
 */
export function parsedTransferChecked(transfer: {
  source: string;
  destination: string;
  mint: string;
  authority: string;
  tokenAmount: ParsedTokenAmount;
}): JsonRpcResult {
  return {
    program: "spl-token",
    programId: TOKEN_PROGRAM_ADDRESS,
    parsed: {
      type: "transferChecked",
      info: {
        source: transfer.source,
        destination: transfer.destination,
        mint: transfer.mint,
        authority: transfer.authority,
        tokenAmount: uiTokenAmount(transfer.tokenAmount),
      },
    },
    stackHeight: 1,
  };
}

/**
 * A top-level `jsonParsed` spl-token `mintTo` instruction; its `amount` is a string, as agave
 * serves it.
 *
 * @param mint - The mint, destination token account, mint authority and raw amount.
 * @param mint.mint - The token mint.
 * @param mint.account - The destination token account.
 * @param mint.mintAuthority - The mint authority.
 * @param mint.amount - The raw amount minted.
 * @returns The instruction JSON.
 */
export function parsedMintTo(mint: {
  mint: string;
  account: string;
  mintAuthority: string;
  amount: string;
}): JsonRpcResult {
  return {
    program: "spl-token",
    programId: TOKEN_PROGRAM_ADDRESS,
    parsed: {
      type: "mintTo",
      info: {
        mint: mint.mint,
        account: mint.account,
        mintAuthority: mint.mintAuthority,
        amount: mint.amount,
      },
    },
    stackHeight: 1,
  };
}

/**
 * One entry of a transaction's `preTokenBalances` / `postTokenBalances`.
 *
 * @param balance - The token account's index, mint, owner and balance.
 * @param balance.accountIndex - The token account's index in `accountKeys`.
 * @param balance.mint - The token mint.
 * @param balance.owner - The token account's owner.
 * @param balance.tokenAmount - The balance.
 * @returns The balance JSON.
 */
export function parsedTokenBalance(balance: {
  accountIndex: number;
  mint: string;
  owner: string;
  tokenAmount: ParsedTokenAmount;
}): JsonRpcResult {
  return {
    accountIndex: balance.accountIndex,
    mint: balance.mint,
    owner: balance.owner,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: uiTokenAmount(balance.tokenAmount),
  };
}

/**
 * A successful `getTransaction` result in `jsonParsed` encoding, as the RPC serves it with
 * `maxSupportedTransactionVersion: 0`.
 *
 * @param transaction - The transaction's placement, accounts, instructions and token balances.
 * @param transaction.signature - The transaction's signature.
 * @param transaction.slot - The slot it landed in.
 * @param transaction.blockTime - Its block time in Unix seconds.
 * @param transaction.accountKeys - Its account keys; the first is the fee payer.
 * @param transaction.instructions - Its top-level parsed instructions.
 * @param transaction.innerInstructions - Its `meta.innerInstructions` groups, each `{ index, instructions }`.
 * @param transaction.preTokenBalances - Token balances before execution.
 * @param transaction.postTokenBalances - Token balances after execution.
 * @returns The JSON-RPC `result`.
 */
export function parsedTransactionResult(transaction: {
  signature: string;
  slot: number;
  blockTime: number;
  accountKeys: readonly string[];
  instructions: readonly JsonRpcResult[];
  innerInstructions: readonly JsonRpcResult[];
  preTokenBalances: readonly JsonRpcResult[];
  postTokenBalances: readonly JsonRpcResult[];
}): JsonRpcResult {
  return {
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    version: 0,
    meta: {
      err: null,
      status: { Ok: null },
      fee: 5000,
      preBalances: transaction.accountKeys.map(() => 1_000_000_000),
      postBalances: transaction.accountKeys.map(() => 1_000_000_000),
      innerInstructions: transaction.innerInstructions,
      logMessages: [],
      preTokenBalances: transaction.preTokenBalances,
      postTokenBalances: transaction.postTokenBalances,
      rewards: [],
      computeUnitsConsumed: 450,
    },
    transaction: {
      signatures: [transaction.signature],
      message: {
        accountKeys: transaction.accountKeys.map((pubkey, index) => ({
          pubkey,
          signer: index === 0,
          source: "transaction",
          writable: true,
        })),
        instructions: transaction.instructions,
        recentBlockhash: syntheticAddress(0),
      },
    },
  };
}
