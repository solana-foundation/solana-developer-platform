/**
 * Token-2022 Service
 *
 * Operations for creating and managing Token-2022 tokens on Solana.
 * Uses Mosaic SDK transaction builders where available, with direct
 * Token-2022 instruction building for mint initialization.
 */

import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";
import type { TokenExtensionsConfig } from "@sdp/types";
import type { FullTransaction } from "@mosaic/sdk";
import {
  createBurnTransaction,
  createMintToTransaction,
  getFreezeTransaction,
  getThawTransaction,
  resolveTokenAccount,
} from "@mosaic/sdk";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  getInitializeMint2Instruction,
  getMintSize,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
} from "@solana-program/token-2022";
import {
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type Signature,
  type TransactionSigner,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import {
  type SimulationResult,
  confirmTransaction,
  createRpc,
  getMinimumBalanceForRentExemption,
  getRecentBlockhash,
  simulateTransaction,
} from "./rpc";
import { addressAsSigner, getExtensionTypes, safeStringify } from "./token-2022.utils";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateMintOptions {
  /** Token decimals (0-18) */
  decimals: number;
  /** Mint authority address */
  mintAuthority: Address;
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
  private env: Env;
  private signer: TransactionSigner;
  private feePayment?: FeePaymentPort;

  constructor(env: Env, signer: TransactionSigner, feePayment?: FeePaymentPort) {
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
    const rpc = createRpc(this.env);
    const signer = this.signer;

    // Generate a new mint keypair
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Get extension args (undefined if no extensions for correct size calculation)
    const extensionArgs = getExtensionTypes(
      options.extensions,
      options.decimals,
      options.mintAuthority
    );
    const hasExtensions = extensionArgs.length > 0;

    // Calculate mint account size - pass undefined for no extensions
    const mintSize = getMintSize(hasExtensions ? extensionArgs : undefined);

    // Get rent-exempt balance
    const lamports = await getMinimumBalanceForRentExemption(rpc, mintSize);

    // Two different flows based on whether Kora is handling fee payment
    if (this.feePayment) {
      // Get Kora's fee payer address
      const feePayerAddress = await this.feePayment.getFeePayer();

      // Build instructions - use addressAsSigner for fee payer in instruction builders
      const instructions: Instruction[] = [];

      // 1. Create account instruction - payer is Kora's address
      instructions.push(
        getCreateAccountInstruction({
          payer: addressAsSigner(feePayerAddress),
          newAccount: mintKeypair,
          lamports,
          space: mintSize,
          programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        })
      );

      // 2. Pre-initialize extensions (BEFORE initializeMint)
      if (hasExtensions) {
        const preInitInstructions = getPreInitializeInstructionsForMintExtensions(
          mint,
          extensionArgs
        );
        instructions.push(...preInitInstructions);
      }

      // 3. Initialize mint instruction
      instructions.push(
        getInitializeMint2Instruction({
          mint,
          decimals: options.decimals,
          mintAuthority: options.mintAuthority,
          freezeAuthority: options.freezeAuthority ?? undefined,
        })
      );

      // 4. Post-initialize extensions (AFTER initializeMint)
      if (hasExtensions) {
        const postInitInstructions = getPostInitializeInstructionsForMintExtensions(
          mint,
          addressAsSigner(feePayerAddress),
          extensionArgs
        );
        instructions.push(...postInitInstructions);
      }

      const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

      // Two-signer flow: mint keypair signs locally, Kora adds fee payer signature + submits
      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(feePayerAddress, msg),
        (msg) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
        // Only add mint keypair as signer - fee payer signature comes from Kora
        (msg) => addSignersToTransactionMessage([mintKeypair], msg)
      );

      // Partially sign with mint keypair (required for account creation)
      const partiallySignedTx =
        await partiallySignTransactionMessageWithSigners(transactionMessage);

      // Serialize the partially signed transaction and copy to mutable Uint8Array
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));

      // Send to Kora for fee payer signature and submission
      const signature = await this.feePayment.signAndSend(txBytes);

      // Wait for confirmation
      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`Mint creation failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        mint,
        signature,
        slot: confirmation.slot,
      };
    }

    // Original single-signer flow: custody pays and signs everything
    const instructions: Instruction[] = [];

    // 1. Create account instruction
    instructions.push(
      getCreateAccountInstruction({
        payer: signer,
        newAccount: mintKeypair,
        lamports,
        space: mintSize,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      })
    );

    // 2. Pre-initialize extensions (BEFORE initializeMint)
    if (hasExtensions) {
      const preInitInstructions = getPreInitializeInstructionsForMintExtensions(
        mint,
        extensionArgs
      );
      instructions.push(...preInitInstructions);
    }

    // 3. Initialize mint instruction
    instructions.push(
      getInitializeMint2Instruction({
        mint,
        decimals: options.decimals,
        mintAuthority: options.mintAuthority,
        freezeAuthority: options.freezeAuthority ?? undefined,
      })
    );

    // 4. Post-initialize extensions (AFTER initializeMint)
    if (hasExtensions) {
      const postInitInstructions = getPostInitializeInstructionsForMintExtensions(
        mint,
        signer,
        extensionArgs
      );
      instructions.push(...postInitInstructions);
    }

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(signer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg),
      (msg) => addSignersToTransactionMessage([signer, mintKeypair], msg)
    );

    // Sign the transaction
    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);

    // Encode to base64 wire format and send
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: true,
        encoding: "base64",
      })
      .send();

    // Wait for confirmation
    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`Mint creation failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      mint,
      signature,
      slot: confirmation.slot,
    };
  }

  /**
   * Prepare an unsigned mint creation transaction
   */
  async prepareCreateMint(
    options: CreateMintOptions,
    requestSimulation = false
  ): Promise<PreparedTransaction & { mint: Address }> {
    const rpc = createRpc(this.env);
    const signer = this.signer;

    // Generate a new mint keypair
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Get extension args (undefined if no extensions for correct size calculation)
    const extensionArgs = getExtensionTypes(
      options.extensions,
      options.decimals,
      options.mintAuthority
    );
    const hasExtensions = extensionArgs.length > 0;

    // Calculate mint account size - pass undefined for no extensions
    const mintSize = getMintSize(hasExtensions ? extensionArgs : undefined);
    const lamports = await getMinimumBalanceForRentExemption(rpc, mintSize);

    // Build instructions using the library's built-in helpers
    const instructions: Instruction[] = [];

    // 1. Create account instruction
    instructions.push(
      getCreateAccountInstruction({
        payer: signer,
        newAccount: mintKeypair,
        lamports,
        space: mintSize,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      })
    );

    // 2. Pre-initialize extensions (BEFORE initializeMint) - uses library helper
    if (hasExtensions) {
      const preInitInstructions = getPreInitializeInstructionsForMintExtensions(
        mint,
        extensionArgs
      );
      instructions.push(...preInitInstructions);
    }

    // 3. Initialize mint instruction
    instructions.push(
      getInitializeMint2Instruction({
        mint,
        decimals: options.decimals,
        mintAuthority: options.mintAuthority,
        freezeAuthority: options.freezeAuthority ?? undefined,
      })
    );

    // 4. Post-initialize extensions (AFTER initializeMint) - uses library helper
    if (hasExtensions) {
      const postInitInstructions = getPostInitializeInstructionsForMintExtensions(
        mint,
        signer,
        extensionArgs
      );
      instructions.push(...postInitInstructions);
    }

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(signer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg)
    );

    const compiledTx = compileTransaction(transactionMessage);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      mint,
      serializedTx,
      blockhash: blockhash as string,
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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;

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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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

    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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

    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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
    const rpc = createRpc(this.env) as Rpc<SolanaRpcApi>;
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
