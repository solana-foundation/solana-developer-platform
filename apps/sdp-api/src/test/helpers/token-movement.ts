import type { AssetRef } from "@sdp/solana/asset-ref";
import { type MovementQuote, quoteMovement } from "@sdp/solana/movement-quote";
import { baseUnits, parseTokenAmount, toBaseUnits } from "@sdp/solana/token-amount";
import { decodeTokenTerms, type MintTokenTerms, NATIVE_TOKEN_TERMS } from "@sdp/solana/token-terms";
import type { TokenMovementBasis } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS, type TokenProgramKind } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  decompileTransactionMessage,
  type EncodedAccount,
  getAddressDecoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Instruction,
  lamports,
  type ReadonlyUint8Array,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  AccountState,
  type ExtensionArgs,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
} from "@solana-program/token-2022";
import { z } from "zod";
import type { PaymentRequestExpectation } from "@/db/repositories/payment-requests.repository";
import type { RecurringMandate } from "@/db/repositories/recurring-mandate";
import type {
  ClusterRpcReply,
  ClusterRpcRequest,
  ClusterRpcResponder,
  JsonRpcResult,
} from "@/test/helpers/cluster-rpc";

/** The Clock a stubbed chain answers with: slot 4 200, epoch 900, 2027-01-15. */
export const TEST_CLOCK = {
  slot: 4_200n,
  unixTimestamp: unixTimestamp(1_800_000_000n),
  epoch: 900n,
} as const;

const SYSVAR_PROGRAM = "Sysvar1111111111111111111111111111111111111";

const MINT_AUTHORITY: Address = getAddressDecoder().decode(new Uint8Array(32).fill(2));

/** One account in a base64 `getMultipleAccounts` or `getAccountInfo` answer. */
export function encodedRpcAccount(owner: string, data: ReadonlyUint8Array): JsonRpcResult {
  return {
    data: [getBase64Decoder().decode(data), "base64"],
    executable: false,
    lamports: 2_039_280,
    owner,
    rentEpoch: 0,
    space: data.length,
  };
}

export const CLOCK_RPC_ACCOUNT = encodedRpcAccount(
  SYSVAR_PROGRAM,
  getSysvarClockEncoder().encode({
    slot: TEST_CLOCK.slot,
    epochStartTimestamp: unixTimestamp(1_799_000_000n),
    epoch: TEST_CLOCK.epoch,
    leaderScheduleEpoch: TEST_CLOCK.epoch + 1n,
    unixTimestamp: TEST_CLOCK.unixTimestamp,
  })
);

/** An initialized mint account under `program`, with `extensions` (Token-2022 only). */
export function mintRpcAccount(
  program: TokenProgramKind,
  options: { decimals: number; extensions: ExtensionArgs[] | null }
): JsonRpcResult {
  return encodedRpcAccount(
    SPL_TOKEN_PROGRAMS[program],
    getMintEncoder().encode({
      mintAuthority: MINT_AUTHORITY,
      supply: 1_000_000_000_000n,
      decimals: options.decimals,
      isInitialized: true,
      freezeAuthority: null,
      extensions: options.extensions,
    })
  );
}

/** A transfer-fee config at one rate, as a fee mint carries it. */
export function transferFeeExtension(basisPoints: number, maximumFee: bigint): ExtensionArgs {
  const rate = { epoch: 0n, maximumFee, transferFeeBasisPoints: basisPoints };
  return transferFeeScheduleExtension(rate, rate);
}

/** One entry of a mint's transfer fee schedule: in force from `epoch`. */
export type TransferFeeEntry = {
  epoch: bigint;
  maximumFee: bigint;
  transferFeeBasisPoints: number;
};

/** A `TransferFeeConfig` with its two fee entries as given. */
export function transferFeeScheduleExtension(
  older: TransferFeeEntry,
  newer: TransferFeeEntry
): ExtensionArgs {
  return {
    __kind: "TransferFeeConfig",
    transferFeeConfigAuthority: MINT_AUTHORITY,
    withdrawWithheldAuthority: MINT_AUTHORITY,
    withheldAmount: 0n,
    olderTransferFee: older,
    newerTransferFee: newer,
  };
}

/** An owner's existing token account of `mint`. */
export function tokenRpcAccount(
  program: TokenProgramKind,
  account: { mint: string; owner: string; amount: bigint; extensions: ExtensionArgs[] | null }
): JsonRpcResult {
  return encodedRpcAccount(
    SPL_TOKEN_PROGRAMS[program],
    getTokenEncoder().encode({
      mint: address(account.mint),
      owner: address(account.owner),
      amount: account.amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions: account.extensions,
    })
  );
}

/** `owner`'s associated token account of `mint` under `program`. */
export async function associatedTokenAccount(
  program: TokenProgramKind,
  mint: string,
  owner: string
): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: address(SPL_TOKEN_PROGRAMS[program]),
  });
  return tokenAccount;
}

const multipleAccountsParamsSchema = z.tuple([z.array(z.string())]).rest(z.unknown());

/**
 * Answers every `getMultipleAccounts` of the current test from `accounts`, by
 * requested address: the Clock sysvar always, every other address missing
 * unless `accounts` holds it. A token movement's read asks for the mint, the
 * Clock and the destinations' token accounts in one request.
 */
export function answerMovementAccounts(
  rpc: ClusterRpcResponder,
  accounts: ReadonlyMap<string, JsonRpcResult>
): void {
  rpc.respond("getMultipleAccounts", (request) => movementAccountsReply(accounts, request));
}

/** The `getMultipleAccounts` answer {@link answerMovementAccounts} gives one request. */
export function movementAccountsReply(
  accounts: ReadonlyMap<string, JsonRpcResult>,
  request: ClusterRpcRequest
): ClusterRpcReply {
  const [addresses] = multipleAccountsParamsSchema.parse(request.params);
  return {
    result: {
      context: { slot: Number(TEST_CLOCK.slot) },
      value: addresses.map((requested) =>
        requested === SYSVAR_CLOCK_ADDRESS ? CLOCK_RPC_ACCOUNT : (accounts.get(requested) ?? null)
      ),
    },
  };
}

/** Whether a recorded `getMultipleAccounts` request read `account`. */
export function readsAccount(request: ClusterRpcRequest, account: string): boolean {
  const [addresses] = multipleAccountsParamsSchema.parse(request.params);
  return addresses.includes(account);
}

/** A debit or credit quote of `amount` under native SOL terms. */
export function nativeQuote(amount: string, basis: TokenMovementBasis): MovementQuote {
  return quoteMovement(NATIVE_TOKEN_TERMS, {
    asset: NATIVE_TOKEN_TERMS.asset,
    amount: parseTokenAmount(amount, NATIVE_TOKEN_TERMS.decimals),
    basis,
  });
}

/** Each instruction of the transaction bytes a send was handed: its program, accounts and data. */
export function sentInstructions(transactionBytes: Uint8Array) {
  const transaction = getTransactionDecoder().decode(transactionBytes);
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
  );
  const instructions: readonly Instruction[] = message.instructions;
  return instructions.map((instruction) => ({
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((account) => account.address),
    data: instruction.data,
  }));
}

/**
 * A classic mint's recurring mandate: `amount` token units of `mint` at
 * `decimals`, under spl-token, with no fee tolerance (the mint has no fee).
 */
export function testMandate(mint: string, amount: string, decimals: number): RecurringMandate {
  return {
    asset: { kind: "token", mint: address(mint), program: "spl-token" },
    decimals,
    debit: toBaseUnits(parseTokenAmount(amount, decimals)),
    maxFeePerPull: baseUnits(0n),
  };
}

/** A payment request's expectation: `amount` token units of `asset` at `decimals`, as a credit. */
export function testExpectation(
  asset: AssetRef,
  amount: string,
  decimals: number
): PaymentRequestExpectation {
  return { asset, decimals, credit: toBaseUnits(parseTokenAmount(amount, decimals)) };
}

/**
 * A mint's Token Terms as `fetchTokenTerms` reads them at {@link TEST_CLOCK},
 * for a test that stubs the read itself.
 */
export function mintTermsAt(
  mint: string,
  program: TokenProgramKind,
  options: { decimals: number; extensions: ExtensionArgs[] | null }
): MintTokenTerms {
  const toEncoded = (at: string, account: JsonRpcResult): EncodedAccount => {
    const parsed = encodedAccountSchema.parse(account);
    const data = getBase64Encoder().encode(parsed.data[0]);
    return {
      address: address(at),
      data: new Uint8Array(data),
      executable: false,
      lamports: lamports(BigInt(parsed.lamports)),
      programAddress: address(parsed.owner),
      space: BigInt(data.length),
    };
  };
  return decodeTokenTerms(
    { kind: "token", mint: address(mint), program },
    {
      mint: toEncoded(mint, mintRpcAccount(program, options)),
      clock: toEncoded(SYSVAR_CLOCK_ADDRESS, CLOCK_RPC_ACCOUNT),
    }
  );
}

const encodedAccountSchema = z.object({
  data: z.tuple([z.string(), z.literal("base64")]),
  lamports: z.number(),
  owner: z.string(),
});
