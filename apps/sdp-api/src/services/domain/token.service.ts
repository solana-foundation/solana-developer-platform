/**
 * Token Service
 *
 * Domain service for Token-2022 operations.
 * Uses ports for RPC, signing, and fee payment.
 */

import type { TokenExtensionsConfig } from "@sdp/types";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  type ExtensionArgs,
  TOKEN_2022_PROGRAM_ADDRESS,
  extension,
  findAssociatedTokenPda,
  getBurnInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
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
  type Signature,
  type TransactionSigner,
  generateKeyPairSigner,
} from "@solana/kit";

/**
 * Create a pseudo-signer from an address for instruction building.
 * The actual signing will be done by the SigningPort/FeePaymentPort.
 *
 * This is needed because instruction builders require TransactionSigner,
 * but in the hexagonal architecture we defer signing to the ports.
 */
function addressAsSigner(address: Address): TransactionSigner<string> {
  return {
    address,
  } as TransactionSigner<string>;
}
import type { FeePaymentPort, RpcPort, SigningPort } from "@/services/ports";
import {
  type PreparedTransaction,
  type SignAndSendResult,
  TransactionService,
} from "./transaction.service";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateMintParams {
  /** Token decimals (0-18) */
  decimals: number;
  /** Mint authority address (usually the custody wallet) */
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
}

export interface MintToParams {
  /** Mint address */
  mint: Address;
  /** Destination wallet address (owner) */
  destination: Address;
  /** Amount to mint (in base units) */
  amount: bigint;
  /** Mint authority address */
  mintAuthority: Address;
}

export interface MintToResult {
  /** Transaction signature */
  signature: Signature;
  /** Destination token account */
  tokenAccount: Address;
}

export interface BurnParams {
  /** Mint address */
  mint: Address;
  /** Source token account or owner address */
  source: Address;
  /** Amount to burn (in base units) */
  amount: bigint;
  /** Owner/authority address */
  authority: Address;
}

export interface FreezeParams {
  /** Mint address */
  mint: Address;
  /** Token account to freeze/thaw */
  account: Address;
  /** Freeze authority address */
  freezeAuthority: Address;
}

export interface TokenOperationResult {
  signature: Signature;
}

export interface PreparedMintCreation extends PreparedTransaction {
  mint: Address;
}

export interface PreparedMintTo extends PreparedTransaction {
  tokenAccount: Address;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Domain service for Token-2022 operations.
 * Supports both execute (custody signs + Kora submits) and prepare (client signs) modes.
 */
export class TokenService {
  private transactionService: TransactionService;

  constructor(
    private rpc: RpcPort,
    private signing: SigningPort,
    private feePayment: FeePaymentPort
  ) {
    this.transactionService = new TransactionService(rpc, signing, feePayment);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mint Creation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new Token-2022 mint and deploy it.
   */
  async createMint(params: CreateMintParams): Promise<CreateMintResult | SignAndSendResult> {
    // Generate a new mint keypair
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Build instructions
    const instructions = await this.buildCreateMintInstructions(mint, params);

    // The mint keypair must sign, plus the fee payer (Kora)
    // For now, we need to handle this differently since the mint keypair
    // is ephemeral and not in custody. We'll need to sign locally first.
    // TODO: Handle mint keypair signing properly in the gasless flow

    const built = await this.transactionService.buildTransaction({
      instructions,
      signers: [mintKeypair.address], // Mint keypair needs to sign
    });

    const result = await this.transactionService.signAndSend(built);

    if (result.pending || !result.signature) {
      return result;
    }

    return {
      mint,
      signature: result.signature,
    };
  }

  /**
   * Prepare an unsigned mint creation transaction.
   */
  async prepareCreateMint(params: CreateMintParams): Promise<PreparedMintCreation> {
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    const instructions = await this.buildCreateMintInstructions(mint, params);

    const prepared = await this.transactionService.prepareTransaction({
      instructions,
      signers: [mint],
    });

    return {
      ...prepared,
      mint,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mint To
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mint tokens to a destination address.
   */
  async mintTo(params: MintToParams): Promise<MintToResult | SignAndSendResult> {
    const feePayer = await this.feePayment.getFeePayer();

    // Get or derive the destination token account
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: params.mint,
      owner: params.destination,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instructions = await this.buildMintToInstructions(params, tokenAccount, feePayer);

    const built = await this.transactionService.buildTransaction({
      instructions,
      signers: [params.mintAuthority], // Mint authority needs to sign
    });

    const result = await this.transactionService.signAndSend(built);

    if (result.pending || !result.signature) {
      return result;
    }

    return {
      signature: result.signature,
      tokenAccount,
    };
  }

  /**
   * Prepare an unsigned mint-to transaction.
   */
  async prepareMintTo(params: MintToParams): Promise<PreparedMintTo> {
    const feePayer = await this.feePayment.getFeePayer();

    const [tokenAccount] = await findAssociatedTokenPda({
      mint: params.mint,
      owner: params.destination,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instructions = await this.buildMintToInstructions(params, tokenAccount, feePayer);

    const prepared = await this.transactionService.prepareTransaction({
      instructions,
      signers: [params.mintAuthority],
    });

    return {
      ...prepared,
      tokenAccount,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Burn
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Burn tokens from a token account.
   */
  async burn(params: BurnParams): Promise<TokenOperationResult | SignAndSendResult> {
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: params.mint,
      owner: params.source,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instruction = getBurnInstruction({
      account: tokenAccount,
      mint: params.mint,
      authority: params.authority,
      amount: params.amount,
    });

    const built = await this.transactionService.buildTransaction({
      instructions: [instruction],
      signers: [params.authority],
    });

    const result = await this.transactionService.signAndSend(built);

    if (result.pending || !result.signature) {
      return result;
    }

    return { signature: result.signature };
  }

  /**
   * Prepare an unsigned burn transaction.
   */
  async prepareBurn(params: BurnParams): Promise<PreparedTransaction> {
    const [tokenAccount] = await findAssociatedTokenPda({
      mint: params.mint,
      owner: params.source,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });

    const instruction = getBurnInstruction({
      account: tokenAccount,
      mint: params.mint,
      authority: params.authority,
      amount: params.amount,
    });

    return this.transactionService.prepareTransaction({
      instructions: [instruction],
      signers: [params.authority],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Freeze / Thaw
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Freeze a token account.
   */
  async freezeAccount(params: FreezeParams): Promise<TokenOperationResult | SignAndSendResult> {
    const instruction = getFreezeAccountInstruction({
      account: params.account,
      mint: params.mint,
      owner: params.freezeAuthority,
    });

    const built = await this.transactionService.buildTransaction({
      instructions: [instruction],
      signers: [params.freezeAuthority],
    });

    const result = await this.transactionService.signAndSend(built);

    if (result.pending || !result.signature) {
      return result;
    }

    return { signature: result.signature };
  }

  /**
   * Prepare an unsigned freeze transaction.
   */
  async prepareFreezeAccount(params: FreezeParams): Promise<PreparedTransaction> {
    const instruction = getFreezeAccountInstruction({
      account: params.account,
      mint: params.mint,
      owner: params.freezeAuthority,
    });

    return this.transactionService.prepareTransaction({
      instructions: [instruction],
      signers: [params.freezeAuthority],
    });
  }

  /**
   * Thaw (unfreeze) a token account.
   */
  async thawAccount(params: FreezeParams): Promise<TokenOperationResult | SignAndSendResult> {
    const instruction = getThawAccountInstruction({
      account: params.account,
      mint: params.mint,
      owner: params.freezeAuthority,
    });

    const built = await this.transactionService.buildTransaction({
      instructions: [instruction],
      signers: [params.freezeAuthority],
    });

    const result = await this.transactionService.signAndSend(built);

    if (result.pending || !result.signature) {
      return result;
    }

    return { signature: result.signature };
  }

  /**
   * Prepare an unsigned thaw transaction.
   */
  async prepareThawAccount(params: FreezeParams): Promise<PreparedTransaction> {
    const instruction = getThawAccountInstruction({
      account: params.account,
      mint: params.mint,
      owner: params.freezeAuthority,
    });

    return this.transactionService.prepareTransaction({
      instructions: [instruction],
      signers: [params.freezeAuthority],
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async buildCreateMintInstructions(
    mint: Address,
    params: CreateMintParams
  ): Promise<Instruction[]> {
    const feePayer = await this.feePayment.getFeePayer();

    // Get extension args
    const extensionArgs = this.getExtensionTypes(params.extensions);
    const hasExtensions = extensionArgs.length > 0;

    // Calculate mint account size
    const mintSize = getMintSize(hasExtensions ? extensionArgs : undefined);

    // Get rent-exempt balance
    const lamports = await this.rpc.getMinimumBalanceForRentExemption(mintSize);

    const instructions: Instruction[] = [];

    // 1. Create account instruction
    instructions.push(
      getCreateAccountInstruction({
        payer: addressAsSigner(feePayer),
        newAccount: addressAsSigner(mint),
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
        decimals: params.decimals,
        mintAuthority: params.mintAuthority,
        freezeAuthority: params.freezeAuthority ?? undefined,
      })
    );

    // 4. Post-initialize extensions (AFTER initializeMint)
    if (hasExtensions) {
      const postInitInstructions = getPostInitializeInstructionsForMintExtensions(
        mint,
        addressAsSigner(feePayer), // Use fee payer as the authority for post-init
        extensionArgs
      );
      instructions.push(...postInitInstructions);
    }

    return instructions;
  }

  private async buildMintToInstructions(
    params: MintToParams,
    tokenAccount: Address,
    feePayer: Address
  ): Promise<Instruction[]> {
    const instructions: Instruction[] = [];

    // Create ATA if it doesn't exist
    const ataExists = await this.rpc.accountExists(tokenAccount);
    if (!ataExists) {
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: addressAsSigner(feePayer),
          owner: params.destination,
          mint: params.mint,
          ata: tokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        })
      );
    }

    // Add mint instruction
    instructions.push(
      getMintToInstruction({
        mint: params.mint,
        token: tokenAccount,
        mintAuthority: params.mintAuthority,
        amount: params.amount,
      })
    );

    return instructions;
  }

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
