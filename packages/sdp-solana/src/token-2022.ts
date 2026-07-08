/**
 * Token-2022 Service
 *
 * Operations for creating and managing Token-2022 tokens on Solana.
 * Uses Mosaic SDK transaction builders for mint creation and management.
 */

import type { RpcEnv } from "@sdp/rpc";
import {
  confirmTransaction,
  createRpcForSdk,
  type SimulationResult,
  simulateTransaction,
} from "@sdp/rpc/solana";
import type { TokenExtensionsConfig } from "@sdp/types";
import {
  type Address,
  assertIsAddress,
  compileTransaction,
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import type { FullTransaction } from "@solana/mosaic-sdk";
import {
  createBurnTransaction,
  createCustomTokenInitTransaction,
  createMintToTransaction,
  getFreezeTransaction,
  getThawTransaction,
  resolveTokenAccount,
} from "@solana/mosaic-sdk";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import { parseDecimalAmount } from "./amount";
import { safeStringify } from "./token-2022.utils";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type MosaicSdkRpc = Parameters<typeof resolveTokenAccount>[0];

declare const Buffer: {
  from(data: string, encoding: "base64"): Uint8Array;
};

/**
 * Environment bindings required by the Token-2022 service.
 *
 * Structural subset of the API app's `Env`; the package never reads
 * `process.env` directly.
 */
export type Token2022Env = RpcEnv & {
  SOLANA_MOCK?: string;
};

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

export interface CreateMintOptions {
  /** Token metadata */
  metadata: {
    name: string;
    symbol: string;
    uri: string;
  };
  /** Token decimals (0-18) */
  decimals: number;
  /** Mint authority address */
  mintAuthority: Address | TransactionSigner;
  /** Freeze authority address (null to disable freezing) */
  freezeAuthority: Address | null;
  /** Token-2022 extensions configuration */
  extensions?: TokenExtensionsConfig;
}

export interface CreateMintResult {
  /** The new mint address */
  mint: Address;
  /** Transaction signature */
  signature: Signature;
  /** Confirmation slot */
  slot: bigint;
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

export interface MintToOptions {
  /** Mint address */
  mint: Address;
  /** Destination wallet address (owner) */
  destination: Address;
  /** Amount to mint (in UI/decimal units) */
  amount: number;
  /** Mint authority signer (KeyPairSigner or custody TransactionSigner) */
  mintAuthority: TransactionSigner;
}

export interface MintToResult {
  /** Transaction signature */
  signature: Signature;
  /** Confirmation slot */
  slot: bigint;
  /** Destination token account */
  tokenAccount: Address;
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

export interface FreezeOptions {
  /** Mint address */
  mint: Address;
  /** Token account to freeze */
  account: Address;
  /** Freeze authority signer (KeyPairSigner or custody TransactionSigner) */
  freezeAuthority: TransactionSigner;
}

export interface FreezeResult {
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

  private buildCustomTokenOptions(options: CreateMintOptions): {
    enableDefaultAccountState?: boolean;
    defaultAccountStateInitialized?: boolean;
    enablePermanentDelegate?: boolean;
    permanentDelegateAuthority?: Address;
    enablePausable?: boolean;
    pausableAuthority?: Address;
    enableTransferFee?: boolean;
    transferFeeAuthority?: Address;
    withdrawWithheldAuthority?: Address;
    transferFeeBasisPoints?: number;
    transferFeeMaximum?: bigint;
    enableInterestBearing?: boolean;
    interestBearingAuthority?: Address;
    interestRate?: number;
    enableNonTransferable?: boolean;
    enableScaledUiAmount?: boolean;
    scaledUiAmountAuthority?: Address;
    scaledUiAmountMultiplier?: number;
    scaledUiAmountNewMultiplier?: number;
    scaledUiAmountNewMultiplierEffectiveTimestamp?: number;
    enableTransferHook?: boolean;
    transferHookAuthority?: Address;
    transferHookProgramId?: Address;
    freezeAuthority?: Address;
  } {
    const extensions = options.extensions ?? {};
    const transferFee = extensions.transferFee;
    const interestBearing = extensions.interestBearing;
    const defaultAccountState = extensions.defaultAccountState;
    const scaledUiAmount = extensions.scaledUiAmount;
    const transferHook = extensions.transferHook;
    const transferFeeMaximum = transferFee
      ? parseDecimalAmount(transferFee.maxFee, options.decimals)
      : undefined;

    const toAddress = (value: string, fieldName: string): Address => {
      try {
        assertIsAddress(value);
        return value;
      } catch {
        throw new Error(`Invalid Solana address for ${fieldName}: ${value}`);
      }
    };

    return {
      enableDefaultAccountState: defaultAccountState !== undefined,
      defaultAccountStateInitialized:
        defaultAccountState !== undefined ? defaultAccountState !== "frozen" : undefined,
      enablePermanentDelegate: !!extensions.permanentDelegate,
      permanentDelegateAuthority: extensions.permanentDelegate
        ? toAddress(extensions.permanentDelegate, "extensions.permanentDelegate")
        : undefined,
      enablePausable: !!extensions.pausable,
      pausableAuthority: extensions.pausable?.authority
        ? toAddress(extensions.pausable.authority, "extensions.pausable.authority")
        : undefined,
      enableTransferFee: !!transferFee,
      transferFeeAuthority: transferFee
        ? toAddress(
            transferFee.transferFeeConfigAuthority,
            // biome-ignore lint/security/noSecrets: Not a secret, used as an error path label.
            "extensions.transferFee.transferFeeConfigAuthority"
          )
        : undefined,
      withdrawWithheldAuthority: transferFee
        ? toAddress(
            transferFee.withdrawWithheldAuthority,
            // biome-ignore lint/security/noSecrets: Not a secret, used as an error path label.
            "extensions.transferFee.withdrawWithheldAuthority"
          )
        : undefined,
      transferFeeBasisPoints: transferFee?.basisPoints,
      transferFeeMaximum,
      enableInterestBearing: !!interestBearing,
      interestBearingAuthority: interestBearing
        ? toAddress(interestBearing.rateAuthority, "extensions.interestBearing.rateAuthority")
        : undefined,
      interestRate: interestBearing?.rate,
      enableNonTransferable: extensions.nonTransferable === true,
      enableScaledUiAmount: !!scaledUiAmount,
      scaledUiAmountAuthority: scaledUiAmount?.authority
        ? toAddress(scaledUiAmount.authority, "extensions.scaledUiAmount.authority")
        : undefined,
      scaledUiAmountMultiplier: scaledUiAmount?.multiplier,
      scaledUiAmountNewMultiplier: scaledUiAmount?.newMultiplier,
      scaledUiAmountNewMultiplierEffectiveTimestamp:
        scaledUiAmount?.newMultiplierEffectiveTimestamp,
      enableTransferHook: !!transferHook,
      transferHookAuthority: transferHook?.authority
        ? toAddress(transferHook.authority, "extensions.transferHook.authority")
        : undefined,
      transferHookProgramId: transferHook
        ? toAddress(transferHook.programId, "extensions.transferHook.programId")
        : undefined,
      freezeAuthority: options.freezeAuthority ?? undefined,
    };
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
    rpc: Rpc<SolanaRpcApi>,
    failureMessage: string
  ): Promise<{ signature: Signature; slot: bigint }> {
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
  // Mint Creation
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a new Token-2022 mint and deploy it to Solana
   */
  async createMint(options: CreateMintOptions): Promise<CreateMintResult> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const mintKeypair = await generateKeyPairSigner();
    const feePayer = await this.resolveFeePayerSigner();

    const fullTx = await createCustomTokenInitTransaction(
      rpc,
      options.metadata.name,
      options.metadata.symbol,
      options.decimals,
      options.metadata.uri,
      options.mintAuthority,
      mintKeypair,
      feePayer,
      this.buildCustomTokenOptions(options)
    );

    const result = await this.signAndSubmit(fullTx, rpc, "Mint creation failed");

    return {
      mint: mintKeypair.address,
      signature: result.signature,
      slot: result.slot,
    };
  }

  /**
   * Prepare an unsigned mint creation transaction
   */
  async prepareCreateMint(
    options: CreateMintOptions,
    requestSimulation = false
  ): Promise<PreparedTransaction & { mint: Address }> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const mintKeypair = await generateKeyPairSigner();
    const feePayer = await this.resolveFeePayerSigner();

    const fullTx = await createCustomTokenInitTransaction(
      rpc,
      options.metadata.name,
      options.metadata.symbol,
      options.decimals,
      options.metadata.uri,
      options.mintAuthority,
      mintKeypair,
      feePayer,
      this.buildCustomTokenOptions(options)
    );

    const compiledTx = compileTransaction(fullTx);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);
    const lifetimeConstraint = (
      fullTx as {
        lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint };
      }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      mint: mintKeypair.address,
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Mint To
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Mint tokens to a destination address
   */
  async mintTo(options: MintToOptions): Promise<MintToResult> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner(options.mintAuthority);

    const fullTx = await createMintToTransaction(
      rpc,
      options.mint,
      options.destination,
      options.amount,
      options.mintAuthority,
      feePayer
    );

    const result = await this.signAndSubmit(fullTx, rpc, "Mint failed");
    const tokenAccountInfo = await resolveTokenAccount(rpc, options.destination, options.mint);

    return {
      signature: result.signature,
      slot: result.slot,
      tokenAccount: tokenAccountInfo.tokenAccount,
    };
  }

  /**
   * Prepare an unsigned mint transaction
   */
  async prepareMintTo(
    options: Omit<MintToOptions, "mintAuthority"> & { mintAuthority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction & { tokenAccount: Address }> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner();

    const fullTx = await createMintToTransaction(
      rpc,
      options.mint,
      options.destination,
      options.amount,
      createNoopSigner(options.mintAuthority),
      feePayer
    );

    const compiledTx = compileTransaction(fullTx);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);
    const lifetimeConstraint = (
      fullTx as {
        lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint };
      }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    const tokenAccountInfo = await resolveTokenAccount(rpc, options.destination, options.mint);

    return {
      tokenAccount: tokenAccountInfo.tokenAccount,
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
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
    requestSimulation = false
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
    const lifetimeConstraint = (
      fullTx as {
        lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint };
      }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Freeze / Thaw
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Freeze a token account
   */
  async freezeAccount(options: FreezeOptions): Promise<FreezeResult> {
    if (this.env.SOLANA_MOCK === "true") {
      return {
        signature: `mock_${crypto.randomUUID()}` as Signature,
        slot: BigInt(Date.now()),
      };
    }

    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner(options.freezeAuthority);

    const fullTx = await getFreezeTransaction({
      rpc,
      payer: feePayer,
      authority: options.freezeAuthority,
      tokenAccount: options.account,
    });

    const result = await this.signAndSubmit(fullTx, rpc, "Freeze failed");

    return {
      signature: result.signature,
      slot: result.slot,
    };
  }

  /**
   * Thaw (unfreeze) a token account
   */
  async thawAccount(options: FreezeOptions): Promise<FreezeResult> {
    if (this.env.SOLANA_MOCK === "true") {
      return {
        signature: `mock_${crypto.randomUUID()}` as Signature,
        slot: BigInt(Date.now()),
      };
    }

    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner(options.freezeAuthority);

    const fullTx = await getThawTransaction({
      rpc,
      payer: feePayer,
      authority: options.freezeAuthority,
      tokenAccount: options.account,
    });

    const result = await this.signAndSubmit(fullTx, rpc, "Thaw failed");

    return {
      signature: result.signature,
      slot: result.slot,
    };
  }

  /**
   * Prepare an unsigned freeze transaction
   */
  async prepareFreezeAccount(
    options: Omit<FreezeOptions, "freezeAuthority"> & { freezeAuthority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner();
    const authority = createNoopSigner(options.freezeAuthority);

    const fullTx = await getFreezeTransaction({
      rpc,
      payer: feePayer,
      authority,
      tokenAccount: options.account,
    });

    const compiledTx = compileTransaction(fullTx);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);
    const lifetimeConstraint = (
      fullTx as {
        lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint };
      }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
    };
  }

  /**
   * Prepare an unsigned thaw transaction
   */
  async prepareThawAccount(
    options: Omit<FreezeOptions, "freezeAuthority"> & { freezeAuthority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction> {
    const rpc = createRpcForSdk<MosaicSdkRpc>(this.env);
    const feePayer = await this.resolveFeePayerSigner();
    const authority = createNoopSigner(options.freezeAuthority);

    const fullTx = await getThawTransaction({
      rpc,
      payer: feePayer,
      authority,
      tokenAccount: options.account,
    });

    const compiledTx = compileTransaction(fullTx);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);
    const lifetimeConstraint = (
      fullTx as {
        lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint };
      }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash,
      lastValidBlockHeight,
      simulation,
    };
  }

  // No custom burn token account resolver needed; Mosaic handles ATA resolution.
}
