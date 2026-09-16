/**
 * Token-2022 Service
 *
 * Burn and unsigned burn transactions using the Mosaic SDK.
 */

import type { RpcEnv } from "@sdp/rpc";
import {
  confirmTransaction,
  createRpcForSdk,
  type SimulationResult,
  type SolanaRpcSdkBridge,
  simulateTransaction,
} from "@sdp/rpc/solana";
import {
  type Address,
  compileTransaction,
  createNoopSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionEncoder,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import type { FullTransaction } from "@solana/mosaic-sdk";
import { createBurnTransaction, resolveTokenAccount } from "@solana/mosaic-sdk";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { safeStringify } from "./token-2022.utils";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

/**
 * Environment bindings required by the Token-2022 service.
 *
 * Structural subset of the API app's `Env`; the package never reads
 * `process.env` directly.
 */
export type Token2022Env = RpcEnv;

/**
 * Structural port for gasless fee payment sponsorship.
 *
 * Mirrors the API app's `FeePaymentPort` (services/ports) so app adapters
 * remain assignable without the package depending on app code.
 */
export interface FeePaymentPort {
  /** Unique identifier for this fee payment provider */
  readonly providerId: string;
  /** Get the platform's fee payer address. */
  getFeePayer(): Promise<Address>;
  /** Sign a transaction with the fee payer key without sending. */
  signAsFeePayer(transaction: Uint8Array): Promise<Uint8Array>;
  /** Sign a transaction with the fee payer and submit to Solana. */
  signAndSend(transaction: Uint8Array): Promise<Signature>;
}

export interface PreparedTransaction {
  /** Base64-encoded unsigned transaction */
  serializedTx: string;
  /** Blockhash used */
  blockhash: string;
  /** Last valid block height */
  lastValidBlockHeight: bigint;
  /** Simulation result if requested */
  simulation?: SimulationResult;
}

export interface BurnOptions {
  /** Mint address */
  mint: Address;
  /** Source token account or owner address */
  source: Address;
  /** Amount to burn (in UI/decimal units) */
  amount: number;
  /** Owner/authority signer (KeyPairSigner or custody TransactionSigner) */
  authority: TransactionSigner;
}

export interface BurnResult {
  signature: Signature;
  slot: bigint;
}

// ═══════════════════════════════════════════════════════════════════════════
// Token-2022 Service Class
// ═══════════════════════════════════════════════════════════════════════════

export class Token2022Service {
  private env: Token2022Env;
  private signer: TransactionSigner;
  private feePayment?: FeePaymentPort;

  constructor(env: Token2022Env, signer: TransactionSigner, feePayment?: FeePaymentPort) {
    this.env = env;
    this.signer = signer;
    this.feePayment = feePayment;
  }

  private async resolveFeePayerSigner(
    fallback: TransactionSigner = this.signer
  ): Promise<TransactionSigner> {
    if (!this.feePayment) {
      return fallback;
    }

    const feePayer = await this.feePayment.getFeePayer();
    return createNoopSigner(feePayer);
  }

  private async signAndSubmit(
    fullTx: FullTransaction,
    sdkRpc: SolanaRpcSdkBridge<MosaicSdkRpc>,
    failureMessage: string
  ): Promise<{ signature: Signature; slot: bigint }> {
    const rpc = sdkRpc as unknown as Rpc<SolanaRpcApi>;
    if (this.feePayment) {
      const partiallySignedTx = await partiallySignTransactionMessageWithSigners(fullTx);
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));
      const signature = await this.feePayment.signAndSend(txBytes);
      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`${failureMessage}: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    const signedTransaction = await signTransactionMessageWithSigners(fullTx);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();

    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`${failureMessage}: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Burn
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Burn tokens from a token account
   */
  async burn(options: BurnOptions): Promise<BurnResult> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);

    const authorityAta = await resolveTokenAccount(rpc, options.authority.address, options.mint);
    const normalizedSource =
      options.source === options.authority.address ? authorityAta.tokenAccount : options.source;

    if (normalizedSource !== authorityAta.tokenAccount) {
      throw new Error(
        "Burn source must be the authority wallet or its token account. Use force-burn for other accounts."
      );
    }

    const feePayer = await this.resolveFeePayerSigner(options.authority);
    const fullTx = await createBurnTransaction(
      rpc,
      options.mint,
      options.authority,
      options.amount,
      feePayer
    );

    const result = await this.signAndSubmit(fullTx, rpc, "Burn failed");

    return {
      signature: result.signature,
      slot: result.slot,
    };
  }

  /**
   * Prepare an unsigned burn transaction
   */
  async prepareBurn(
    options: Omit<BurnOptions, "authority"> & { authority: Address },
    requestSimulation?: boolean
  ): Promise<PreparedTransaction> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner();

    const authorityAta = await resolveTokenAccount(rpc, options.authority, options.mint);
    const normalizedSource =
      options.source === options.authority ? authorityAta.tokenAccount : options.source;

    if (normalizedSource !== authorityAta.tokenAccount) {
      throw new Error(
        "Burn source must be the authority wallet or its token account. Use force-burn for other accounts."
      );
    }

    const fullTx = await createBurnTransaction(
      rpc,
      options.mint,
      createNoopSigner(options.authority),
      options.amount,
      feePayer
    );

    const compiledTx = compileTransaction(fullTx);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);
    const { blockhash, lastValidBlockHeight } = fullTx.lifetimeConstraint;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = new Uint8Array(getBase64Encoder().encode(serializedTx));
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
    };
  }
}
