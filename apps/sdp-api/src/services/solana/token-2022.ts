/**
 * Token-2022 Service
 *
 * Operations for creating and managing Token-2022 tokens on Solana.
 * Uses @solana-program/token-2022 instruction builders with @solana/kit.
 */

import type { FeePaymentPort } from "@/services/ports";
import type { Env } from "@/types/env";
import type { TokenExtensionsConfig } from "@sdp/types";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  type ExtensionArgs,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getFreezeAccountInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getPostInitializeInstructionsForMintExtensions,
  getPreInitializeInstructionsForMintExtensions,
  getThawAccountInstruction,
} from "@solana-program/token-2022";
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type TransactionSigner,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  compileTransaction,
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
  accountExists,
  confirmTransaction,
  createRpc,
  getMinimumBalanceForRentExemption,
  getRecentBlockhash,
  simulateTransaction,
} from "./rpc";
import { createSigner } from "./signer";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * JSON stringify replacer that handles BigInt values by converting them to strings.
 * Solana RPC responses often contain bigints (slots, lamports) that JSON.stringify can't handle.
 */
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Safely stringify a value that may contain BigInt values
 */
function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigIntReplacer);
}

/**
 * Create a proxy "signer" from an address for use in instruction builders.
 * This allows using an external signer's address (like Kora's fee payer)
 * in instructions without having the actual signing capability locally.
 * The real signature will be added later by the external signer.
 */
function addressAsSigner(address: Address): TransactionSigner {
  return { address } as TransactionSigner;
}

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
  /** Amount to mint (in base units) */
  amount: bigint;
  /** Mint authority signer */
  mintAuthority: KeyPairSigner;
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
  /** Amount to burn (in base units) */
  amount: bigint;
  /** Owner/authority signer */
  authority: KeyPairSigner;
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
  /** Freeze authority signer */
  freezeAuthority: KeyPairSigner;
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
  private feePayment?: FeePaymentPort;

  constructor(env: Env, feePayment?: FeePaymentPort) {
    this.env = env;
    this.feePayment = feePayment;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Mint Creation
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a new Token-2022 mint and deploy it to Solana
   */
  async createMint(options: CreateMintOptions): Promise<CreateMintResult> {
    const rpc = createRpc(this.env);
    const signer = await createSigner(this.env);

    // Generate a new mint keypair
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Get extension args (undefined if no extensions for correct size calculation)
    const extensionArgs = this.getExtensionTypes(options.extensions);
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
    const signer = await createSigner(this.env);

    // Generate a new mint keypair
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Get extension args (undefined if no extensions for correct size calculation)
    const extensionArgs = this.getExtensionTypes(options.extensions);
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
    const rpc = createRpc(this.env);

    // Get or derive the destination token account
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: options.mint,
      owner: options.destination,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const ataExists = await accountExists(rpc, tokenAccount);

    // Two different flows based on whether Kora is handling fee payment
    if (this.feePayment) {
      const feePayerAddress = await this.feePayment.getFeePayer();

      const instructions: Instruction[] = [];

      // Create ATA if it doesn't exist - use addressAsSigner for fee payer
      if (!ataExists) {
        instructions.push(
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: addressAsSigner(feePayerAddress),
            owner: options.destination,
            mint: options.mint,
            ata: tokenAccount,
            tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          })
        );
      }

      // Add mint instruction
      instructions.push(
        getMintToInstruction({
          mint: options.mint,
          token: tokenAccount,
          mintAuthority: options.mintAuthority,
          amount: options.amount,
        })
      );

      const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

      // Two-signer flow: custody signs as mint authority, Kora adds fee payer + submits
      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(feePayerAddress, msg),
        (msg) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
        (msg) => addSignersToTransactionMessage([options.mintAuthority], msg)
      );

      // Sign with mint authority (custody)
      const partiallySignedTx =
        await partiallySignTransactionMessageWithSigners(transactionMessage);

      // Serialize and send to Kora (copy to mutable Uint8Array)
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));
      const signature = await this.feePayment.signAndSend(txBytes);

      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`Mint failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
        tokenAccount,
      };
    }

    // Original single-signer flow
    const instructions: Instruction[] = [];

    // Create ATA if it doesn't exist
    if (!ataExists) {
      instructions.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: options.mintAuthority,
          owner: options.destination,
          mint: options.mint,
          ata: tokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        })
      );
    }

    // Add mint instruction
    instructions.push(
      getMintToInstruction({
        mint: options.mint,
        token: tokenAccount,
        mintAuthority: options.mintAuthority,
        amount: options.amount,
      })
    );

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(options.mintAuthority, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions(instructions, msg)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();
    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`Mint failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
      tokenAccount,
    };
  }

  /**
   * Prepare an unsigned mint transaction
   */
  async prepareMintTo(
    options: Omit<MintToOptions, "mintAuthority"> & { mintAuthority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction & { tokenAccount: Address }> {
    const rpc = createRpc(this.env);
    const signer = await createSigner(this.env);

    const [tokenAccount] = await findAssociatedTokenPda({
      mint: options.mint,
      owner: options.destination,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instructions: Instruction[] = [];

    const ataExists = await accountExists(rpc, tokenAccount);
    if (!ataExists) {
      instructions.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: options.destination,
          mint: options.mint,
          ata: tokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        })
      );
    }

    instructions.push(
      getMintToInstruction({
        mint: options.mint,
        token: tokenAccount,
        mintAuthority: signer,
        amount: options.amount,
      })
    );

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
      tokenAccount,
      serializedTx,
      blockhash: blockhash as string,
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
    const rpc = createRpc(this.env);

    // Derive token account if source is a wallet
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: options.mint,
      owner: options.source,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instruction = getBurnInstruction({
      account: tokenAccount,
      mint: options.mint,
      authority: options.authority,
      amount: options.amount,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    // Two different flows based on whether Kora is handling fee payment
    if (this.feePayment) {
      const feePayerAddress = await this.feePayment.getFeePayer();

      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(feePayerAddress, msg),
        (msg) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
        (msg) => appendTransactionMessageInstructions([instruction], msg),
        (msg) => addSignersToTransactionMessage([options.authority], msg)
      );

      // Sign with authority (custody)
      const partiallySignedTx =
        await partiallySignTransactionMessageWithSigners(transactionMessage);

      // Serialize and send to Kora (copy to mutable Uint8Array)
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));
      const signature = await this.feePayment.signAndSend(txBytes);

      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`Burn failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // Original single-signer flow
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(options.authority, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();
    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`Burn failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
    };
  }

  /**
   * Prepare an unsigned burn transaction
   */
  async prepareBurn(
    options: Omit<BurnOptions, "authority"> & { authority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction> {
    const rpc = createRpc(this.env);
    const signer = await createSigner(this.env);

    const [tokenAccount] = await findAssociatedTokenPda({
      mint: options.mint,
      owner: options.source,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instruction = getBurnInstruction({
      account: tokenAccount,
      mint: options.mint,
      authority: signer,
      amount: options.amount,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(signer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const compiledTx = compileTransaction(transactionMessage);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash: blockhash as string,
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

    const rpc = createRpc(this.env);

    const instruction = getFreezeAccountInstruction({
      account: options.account,
      mint: options.mint,
      owner: options.freezeAuthority,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    // Two different flows based on whether Kora is handling fee payment
    if (this.feePayment) {
      const feePayerAddress = await this.feePayment.getFeePayer();

      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(feePayerAddress, msg),
        (msg) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
        (msg) => appendTransactionMessageInstructions([instruction], msg),
        (msg) => addSignersToTransactionMessage([options.freezeAuthority], msg)
      );

      // Sign with freeze authority (custody)
      const partiallySignedTx =
        await partiallySignTransactionMessageWithSigners(transactionMessage);

      // Serialize and send to Kora (copy to mutable Uint8Array)
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));
      const signature = await this.feePayment.signAndSend(txBytes);

      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`Freeze failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // Original single-signer flow
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(options.freezeAuthority, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();
    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`Freeze failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
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

    const rpc = createRpc(this.env);

    const instruction = getThawAccountInstruction({
      account: options.account,
      mint: options.mint,
      owner: options.freezeAuthority,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    // Two different flows based on whether Kora is handling fee payment
    if (this.feePayment) {
      const feePayerAddress = await this.feePayment.getFeePayer();

      const transactionMessage = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(feePayerAddress, msg),
        (msg) =>
          setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
        (msg) => appendTransactionMessageInstructions([instruction], msg),
        (msg) => addSignersToTransactionMessage([options.freezeAuthority], msg)
      );

      // Sign with freeze authority (custody)
      const partiallySignedTx =
        await partiallySignTransactionMessageWithSigners(transactionMessage);

      // Serialize and send to Kora (copy to mutable Uint8Array)
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));
      const signature = await this.feePayment.signAndSend(txBytes);

      const confirmation = await confirmTransaction(rpc, signature);

      if (confirmation.err) {
        throw new Error(`Thaw failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // Original single-signer flow
    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(options.freezeAuthority, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
    const encodedTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = await rpc
      .sendTransaction(encodedTransaction, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();
    const confirmation = await confirmTransaction(rpc, signature);

    if (confirmation.err) {
      throw new Error(`Thaw failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
    };
  }

  /**
   * Prepare an unsigned freeze transaction
   */
  async prepareFreezeAccount(
    options: Omit<FreezeOptions, "freezeAuthority"> & { freezeAuthority: Address },
    requestSimulation = false
  ): Promise<PreparedTransaction> {
    const rpc = createRpc(this.env);
    const signer = await createSigner(this.env);

    const instruction = getFreezeAccountInstruction({
      account: options.account,
      mint: options.mint,
      owner: signer,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(signer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const compiledTx = compileTransaction(transactionMessage);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash: blockhash as string,
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
    const rpc = createRpc(this.env);
    const signer = await createSigner(this.env);

    const instruction = getThawAccountInstruction({
      account: options.account,
      mint: options.mint,
      owner: signer,
    });

    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc);

    const transactionMessage = pipe(
      createTransactionMessage({ version: 0 }),
      (msg) => setTransactionMessageFeePayerSigner(signer, msg),
      (msg) =>
        setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, msg),
      (msg) => appendTransactionMessageInstructions([instruction], msg)
    );

    const compiledTx = compileTransaction(transactionMessage);
    const serializedTx = getBase64EncodedWireTransaction(compiledTx);

    let simulation: SimulationResult | undefined;
    if (requestSimulation) {
      const txBytes = Buffer.from(serializedTx, "base64");
      simulation = await simulateTransaction(rpc, txBytes);
    }

    return {
      serializedTx,
      blockhash: blockhash as string,
      lastValidBlockHeight,
      simulation,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Get extension args for getMintSize calculation
   */
  private getExtensionTypes(extensions?: TokenExtensionsConfig): ExtensionArgs[] {
    if (!extensions) return [];

    const types: ExtensionArgs[] = [];

    if (extensions.transferFee) {
      types.push(
        // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
        extension("TransferFeeConfig", {
          transferFeeConfigAuthority: extensions.transferFee.transferFeeConfigAuthority as Address,
          withdrawWithheldAuthority: extensions.transferFee.withdrawWithheldAuthority as Address,
          withheldAmount: 0n,
          olderTransferFee: {
            epoch: 0n,
            maximumFee: BigInt(extensions.transferFee.maxFee),
            transferFeeBasisPoints: extensions.transferFee.basisPoints,
          },
          newerTransferFee: {
            epoch: 0n,
            maximumFee: BigInt(extensions.transferFee.maxFee),
            transferFeeBasisPoints: extensions.transferFee.basisPoints,
          },
        })
      );
    }
    if (extensions.permanentDelegate) {
      types.push(
        // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
        extension("PermanentDelegate", {
          delegate: extensions.permanentDelegate as Address,
        })
      );
    }
    if (extensions.defaultAccountState) {
      // 0 = Uninitialized, 1 = Initialized, 2 = Frozen
      const state = extensions.defaultAccountState === "frozen" ? 2 : 1;
      // biome-ignore lint/nursery/noSecrets: Token-2022 extension type identifier
      types.push(extension("DefaultAccountState", { state }));
    }
    if (extensions.nonTransferable) {
      types.push(extension("NonTransferable", {}));
    }

    return types;
  }
}
