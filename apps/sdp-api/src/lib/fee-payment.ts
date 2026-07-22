import type { FeePaymentInstruction, FeePaymentPort } from "@sdp/payments/fee-payment";
import { getSolanaConfig, type RpcEnv } from "@sdp/rpc";
import {
  SPL_TOKEN_PROGRAMS,
  WELL_KNOWN_TOKENS,
  type WellKnownTokenSymbol,
  wellKnownMint,
} from "@sdp/types";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionEncoder,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { getTransferCheckedInstruction } from "@solana-program/token-2022";
import { feePaymentTokenNotConfigured, internalError } from "@/lib/errors";
import type { CustodyWallet } from "@/services/stores/custody-config.store";

export interface WalletFeePaymentToken {
  mint: Address;
  tokenProgram: Address;
  symbol: string;
  decimals: number;
}

export interface WalletFeePayment {
  instruction: FeePaymentInstruction;
  feeToken: WalletFeePaymentToken;
}

type SignableMessage = Parameters<typeof partiallySignTransactionMessageWithSigners>[0];

/**
 * Resolve a well-known token's mint on the active cluster, or undefined when
 * the token has no mint there.
 */
export function wellKnownTokenMintOnCluster(
  env: RpcEnv,
  symbol: WellKnownTokenSymbol
): string | undefined {
  return wellKnownMint(symbol, getSolanaConfig(env).network);
}

/**
 * Resolve the wallet's configured fee payment token to its on-chain identifiers.
 * Throws when the wallet has no feePaymentToken configured, so callers must gate
 * on the fee payment provider's pricing model first.
 */
export function resolveWalletFeePaymentToken(
  env: RpcEnv,
  wallet: CustodyWallet
): WalletFeePaymentToken {
  const symbol = wallet.settings.feePaymentToken;
  if (symbol === undefined) {
    throw feePaymentTokenNotConfigured(wallet.walletId);
  }

  const mint = wellKnownTokenMintOnCluster(env, symbol);
  if (mint === undefined) {
    throw internalError(
      `Fee payment token ${symbol} is unavailable on ${getSolanaConfig(env).network}`
    );
  }
  const token = WELL_KNOWN_TOKENS[symbol];

  return {
    mint: address(mint),
    tokenProgram: address(SPL_TOKEN_PROGRAMS[token.tokenProgram]),
    symbol: token.symbol,
    decimals: token.decimals,
  };
}

/**
 * Sign a transaction message, appending the sponsorship provider's payment
 * instruction first when its pricing model requires payment. Under free
 * pricing the message is signed as-is without compiling a throwaway probe
 * transaction. Returns the fee payment details for callers that record them.
 */
export async function signMessageWithWalletFeePayment(input: {
  env: RpcEnv;
  feePayment: FeePaymentPort;
  wallet: CustodyWallet;
  sourceAddress: Address;
  message: SignableMessage;
}): Promise<{
  partiallySigned: Awaited<ReturnType<typeof partiallySignTransactionMessageWithSigners>>;
  txBytes: Uint8Array;
  walletFeePayment: WalletFeePayment | null;
}> {
  const encoder = getTransactionEncoder();
  const pricingModel = await input.feePayment.getPricingModel();

  if (pricingModel.type === "free") {
    const partiallySigned = await partiallySignTransactionMessageWithSigners(input.message);
    return {
      partiallySigned,
      txBytes: new Uint8Array(encoder.encode(partiallySigned)),
      walletFeePayment: null,
    };
  }

  const feeToken = resolveWalletFeePaymentToken(input.env, input.wallet);
  const instruction = await input.feePayment.getPaymentInstruction({
    transaction: new Uint8Array(encoder.encode(compileTransaction(input.message))),
    sourceWallet: input.sourceAddress,
    feeToken: feeToken.mint,
    tokenProgram: feeToken.tokenProgram,
  });
  const messageWithPayment = appendTransactionMessageInstructions(
    [instruction.instruction],
    input.message
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(messageWithPayment);

  return {
    partiallySigned,
    txBytes: new Uint8Array(encoder.encode(partiallySigned)),
    walletFeePayment: { instruction, feeToken },
  };
}

/**
 * Worst-case stand-in for the provider's payment instruction, used to reserve
 * transaction-size headroom when packing batch chunks. Returns null under free
 * pricing, where no payment instruction will be appended.
 */
export async function buildFeePaymentSizeProbeInstruction(input: {
  env: RpcEnv;
  feePayment: FeePaymentPort;
  wallet: CustodyWallet;
  sourceSigner: TransactionSigner;
}): Promise<Instruction | null> {
  const pricingModel = await input.feePayment.getPricingModel();
  if (pricingModel.type === "free") {
    return null;
  }

  const feeToken = resolveWalletFeePaymentToken(input.env, input.wallet);
  return getTransferCheckedInstruction(
    {
      source: feeToken.mint,
      mint: feeToken.mint,
      destination: feeToken.mint,
      authority: input.sourceSigner,
      amount: 0n,
      decimals: feeToken.decimals,
    },
    { programAddress: feeToken.tokenProgram }
  );
}
