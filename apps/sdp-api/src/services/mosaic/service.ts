/**
 * Mosaic Service
 *
 * Template-based token issuance using @solana/mosaic-sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and ABL integration.
 *
 * The SDK handles:
 * - Token-2022 extension configuration per template
 * - sRFC-37 Token ACL setup (freeze authority delegation)
 * - ABL (Allowlist/Blocklist) on-chain gating
 * - Decimal-aware amount conversion for minting
 */

import { parseDecimalAmount } from "@/lib/amount";
import type { FeePaymentPort } from "@/services/ports/fee-payment.port";
import { confirmTransaction, createRpc } from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  compileTransaction,
  createNoopSigner,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  // Types
  type FullTransaction,
  createArcadeTokenInitTransaction,
  // Template builders
  createCustomTokenInitTransaction,
  createForceBurnTransaction,
  createForceTransferTransaction,
  // Token operations
  createMintToTransaction,
  createPauseTransaction,
  createResumeTransaction,
  createStablecoinInitTransaction,
  createTokenizedSecurityInitTransaction,
  // ABL wallet management (object input pattern)
  getAddWalletTransaction,
  // Token ACL freeze/thaw (object input pattern)
  getFreezeTransaction,
  getRemoveAuthorityTransaction,
  getRemoveWalletTransaction,
  getThawPermissionlessTransaction,
  getThawTransaction,
  getUpdateAuthorityTransaction,
  resolveTokenAccount,
} from "@solana/mosaic-sdk";
import { partiallySignTransactionMessageWithSigners } from "@solana/signers";
import {
  type AblWalletOptions,
  type CreateTokenOptions,
  DEFAULT_ACL_MODE,
  type FreezeThawOptions,
  type MintToOptions,
  type MosaicTransaction,
  type MosaicTransactionResult,
  TEMPLATE_MAP,
} from "./types";
import { safeStringify } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// Mosaic Service
// ═══════════════════════════════════════════════════════════════════════════

export class MosaicService {
  private env: Env;
  private signer: TransactionSigner;
  private feePayment?: FeePaymentPort;
  private rpc: Rpc<SolanaRpcApi>;

  constructor(env: Env, signer: TransactionSigner, feePayment?: FeePaymentPort) {
    this.env = env;
    this.signer = signer;
    this.feePayment = feePayment;
    // Cast is safe - createRpc returns a union of Rpc types that are all compatible
    // with the SolanaRpcApi interface that Mosaic SDK expects
    this.rpc = createRpc(env) as Rpc<SolanaRpcApi>;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token Creation (Templates)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a token using Mosaic templates.
   *
   * Templates configure Token-2022 extensions automatically:
   * - stablecoin: metadata, pausable, default-account-state, confidential-balances, permanent-delegate
   * - arcade: metadata, pausable, default-account-state, permanent-delegate (allowlist-only)
   * - tokenized-security: same as stablecoin + scaled-ui-amount
   */
  async createToken(options: CreateTokenOptions): Promise<MosaicTransactionResult> {
    const mosaicTemplate = TEMPLATE_MAP[options.template];

    // Generate a new mint keypair - Mosaic templates require a signer
    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    // Determine ACL mode and sRFC-37 enablement
    const aclMode = options.aclMode ?? DEFAULT_ACL_MODE[mosaicTemplate];
    const requestedSrfc37 = options.enableTokenAcl ?? options.enableAbl ?? false;
    const enableSrfc37 = requestedSrfc37 && options.freezeAuthority !== null;

    const fullTx = await this.buildCreateTokenTransaction(
      mosaicTemplate,
      options,
      mintKeypair,
      aclMode,
      enableSrfc37
    );

    // Sign and submit with mint keypair
    const result = await this.signAndSubmitWithMintKeypair(fullTx, mintKeypair);

    return {
      ...result,
      mint,
    };
  }

  /**
   * Prepare a token creation transaction (unsigned) for client signing.
   */
  async prepareCreateToken(options: CreateTokenOptions): Promise<MosaicTransaction> {
    const mosaicTemplate = TEMPLATE_MAP[options.template];

    const mintKeypair = await generateKeyPairSigner();
    const mint = mintKeypair.address;

    const aclMode = options.aclMode ?? DEFAULT_ACL_MODE[mosaicTemplate];
    const requestedSrfc37 = options.enableTokenAcl ?? options.enableAbl ?? false;
    const enableSrfc37 = requestedSrfc37 && options.freezeAuthority !== null;

    const fullTx = await this.buildCreateTokenTransaction(
      mosaicTemplate,
      options,
      mintKeypair,
      aclMode,
      enableSrfc37
    );

    return this.toMosaicTransaction(fullTx, mint);
  }

  private async buildCreateTokenTransaction(
    template: string,
    options: CreateTokenOptions,
    mintKeypair: TransactionSigner,
    aclMode: "allowlist" | "blocklist",
    enableSrfc37: boolean
  ): Promise<FullTransaction> {
    // Resolve fee payer - use Kora if available, otherwise from options
    const feePayer = this.feePayment ? await this.feePayment.getFeePayer() : options.feePayer;
    const mintAuthority =
      typeof options.mintAuthority === "string" && options.mintAuthority === this.signer.address
        ? this.signer
        : options.mintAuthority;
    const mintAuthorityAddress =
      typeof options.mintAuthority === "string"
        ? (options.mintAuthority as Address)
        : (options.mintAuthority.address as Address);

    const freezeAuthority = enableSrfc37 ? undefined : (options.freezeAuthority ?? undefined);
    const permanentDelegateAuthority =
      typeof options.extensions?.permanentDelegate === "string"
        ? (options.extensions.permanentDelegate as Address)
        : undefined;
    const pausableAuthority = options.extensions?.pausable?.authority as Address | undefined;
    const scaledUiAmount = options.extensions?.scaledUiAmount;
    const transferHook = options.extensions?.transferHook;

    switch (template) {
      case "stablecoin":
        // Stablecoin: full compliance features with blocklist default
        // Signature: (rpc, name, symbol, decimals, uri, mintAuthority, mint, feePayer,
        //            aclMode?, metadataAuth?, pausableAuth?, confidentialAuth?, delegateAuth?,
        //            enableSrfc37?, freezeAuthority?)
        return createStablecoinInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          aclMode,
          mintAuthorityAddress, // metadataAuthority
          pausableAuthority ?? mintAuthorityAddress, // pausableAuthority
          mintAuthorityAddress, // confidentialBalancesAuthority
          permanentDelegateAuthority ?? mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          freezeAuthority
        );

      case "arcade":
        // Arcade: closed-loop gaming tokens (always allowlist)
        // Note: No aclMode parameter - arcade is always allowlist
        // Signature: (rpc, name, symbol, decimals, uri, mintAuthority, mint, feePayer,
        //            metadataAuth?, pausableAuth?, delegateAuth?, enableSrfc37?, freezeAuthority?)
        return createArcadeTokenInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          mintAuthorityAddress, // metadataAuthority
          pausableAuthority ?? mintAuthorityAddress, // pausableAuthority
          permanentDelegateAuthority ?? mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          freezeAuthority
        );

      case "tokenized-security":
        // Tokenized Security: stablecoin features + scaled UI amount
        // Uses options object for optional parameters
        return createTokenizedSecurityInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          freezeAuthority,
          {
            aclMode,
            metadataAuthority: mintAuthorityAddress,
            pausableAuthority: pausableAuthority ?? mintAuthorityAddress,
            confidentialBalancesAuthority: mintAuthorityAddress,
            permanentDelegateAuthority: permanentDelegateAuthority ?? mintAuthorityAddress,
            enableSrfc37,
            scaledUiAmount: scaledUiAmount
              ? {
                  authority:
                    (scaledUiAmount.authority as Address | undefined) ?? mintAuthorityAddress,
                  multiplier: scaledUiAmount.multiplier,
                  newMultiplier: scaledUiAmount.newMultiplier,
                  newMultiplierEffectiveTimestamp:
                    scaledUiAmount.newMultiplierEffectiveTimestamp ?? undefined,
                }
              : undefined,
          }
        );

      case "custom": {
        const extensions = options.extensions ?? {};
        const transferFee = extensions.transferFee;
        const interestBearing = extensions.interestBearing;
        const defaultAccountState = extensions.defaultAccountState;
        const transferFeeMaximum = transferFee
          ? parseDecimalAmount(transferFee.maxFee, options.decimals)
          : undefined;
        return createCustomTokenInitTransaction(
          this.rpc,
          options.metadata.name,
          options.metadata.symbol,
          options.decimals,
          options.metadata.uri,
          mintAuthority,
          mintKeypair,
          feePayer,
          {
            enableSrfc37,
            aclMode,
            enableDefaultAccountState: !!defaultAccountState,
            defaultAccountStateInitialized:
              defaultAccountState !== undefined ? defaultAccountState !== "frozen" : undefined,
            enablePermanentDelegate: !!extensions.permanentDelegate,
            permanentDelegateAuthority,
            enablePausable: !!extensions.pausable,
            pausableAuthority: pausableAuthority,
            enableTransferFee: !!transferFee,
            transferFeeAuthority: transferFee?.transferFeeConfigAuthority as Address | undefined,
            withdrawWithheldAuthority: transferFee?.withdrawWithheldAuthority as
              | Address
              | undefined,
            transferFeeBasisPoints: transferFee?.basisPoints,
            transferFeeMaximum,
            enableInterestBearing: !!interestBearing,
            interestBearingAuthority: interestBearing?.rateAuthority as Address | undefined,
            interestRate: interestBearing?.rate,
            enableNonTransferable: extensions.nonTransferable === true,
            enableScaledUiAmount: !!scaledUiAmount,
            scaledUiAmountAuthority: scaledUiAmount?.authority as Address | undefined,
            scaledUiAmountMultiplier: scaledUiAmount?.multiplier,
            scaledUiAmountNewMultiplier: scaledUiAmount?.newMultiplier,
            scaledUiAmountNewMultiplierEffectiveTimestamp:
              scaledUiAmount?.newMultiplierEffectiveTimestamp,
            enableTransferHook: !!transferHook,
            transferHookAuthority: transferHook?.authority as Address | undefined,
            transferHookProgramId: transferHook?.programId as Address | undefined,
            freezeAuthority,
          }
        );
      }

      default:
        throw new Error(`Unsupported template: ${template}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Mint tokens to a destination address.
   *
   * The SDK handles:
   * - Creating ATA if needed (idempotent)
   * - Permissionless thaw for sRFC-37 tokens (if account is frozen)
   * - Decimal conversion (amount is decimal, e.g., 100 for 100 tokens)
   */
  async mintTo(options: MintToOptions): Promise<MosaicTransactionResult> {
    const fallbackFeePayer =
      options.feePayer === this.signer.address ? this.signer : options.feePayer;
    const feePayer = await this.resolveFeePayer(fallbackFeePayer);

    // SDK signature: (rpc, mint, recipient, amount, mintAuthority, feePayer)
    // Note: amount is decimal number, SDK converts using mint decimals
    const fullTx = await createMintToTransaction(
      this.rpc,
      options.mint,
      options.destination,
      options.amount,
      this.signer, // mintAuthority as TransactionSigner
      feePayer
    );

    const tokenAccountInfo = await resolveTokenAccount(this.rpc, options.destination, options.mint);
    const result = await this.signAndSubmit(fullTx);

    return {
      ...result,
      tokenAccount: tokenAccountInfo.tokenAccount,
    };
  }

  /**
   * Prepare a mint transaction (unsigned) for client signing.
   */
  async prepareMintTo(
    options: MintToOptions
  ): Promise<MosaicTransaction & { tokenAccount: Address }> {
    const fallbackFeePayer =
      options.feePayer === this.signer.address ? this.signer : options.feePayer;
    const feePayer = await this.resolveFeePayer(fallbackFeePayer);

    const fullTx = await createMintToTransaction(
      this.rpc,
      options.mint,
      options.destination,
      options.amount,
      options.mintAuthority, // Just the address for prepare mode
      feePayer
    );

    const tokenAccountInfo = await resolveTokenAccount(this.rpc, options.destination, options.mint);

    return {
      ...this.toMosaicTransaction(fullTx),
      tokenAccount: tokenAccountInfo.tokenAccount,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ABL (Allowlist/Blocklist) Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Add a wallet to the token's ABL list.
   *
   * For allowlist tokens: allows wallet to receive/hold tokens
   * For blocklist tokens: blocks wallet from receiving/holding tokens
   */
  async addToList(options: AblWalletOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    // SDK uses object input pattern for ABL operations
    const fullTx = await getAddWalletTransaction({
      rpc: this.rpc,
      payer, // payer must be a TransactionSigner
      authority: this.signer, // authority as TransactionSigner
      wallet: options.wallet,
      list: options.list,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Remove a wallet from the token's ABL list.
   */
  async removeFromList(options: AblWalletOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getRemoveWalletTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      wallet: options.wallet,
      list: options.list,
    });

    return this.signAndSubmit(fullTx);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Token ACL (Freeze/Thaw) Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Freeze a token account.
   *
   * The SDK automatically detects whether to use:
   * - Token ACL instruction (if freeze authority is Token ACL program)
   * - Standard SPL Token-2022 freeze (if freeze authority is a wallet)
   */
  async freezeAccount(options: FreezeThawOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    // SDK uses object input pattern - note: NO mint parameter!
    // The SDK fetches mint from the token account
    const fullTx = await getFreezeTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      tokenAccount: options.tokenAccount,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Thaw a token account (requires freeze authority).
   *
   * The SDK automatically detects whether to use:
   * - Token ACL instruction (if freeze authority is Token ACL program)
   * - Standard SPL Token-2022 thaw (if freeze authority is a wallet)
   */
  async thawAccount(options: FreezeThawOptions): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getThawTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      tokenAccount: options.tokenAccount,
    });

    return this.signAndSubmit(fullTx);
  }

  /**
   * Permissionless thaw (sRFC-37).
   *
   * Allows thawing without freeze authority signature when:
   * - Token has sRFC-37 enabled (freeze authority = Token ACL program)
   * - Permissionless thaw is enabled for the mint
   * - Wallet is on the allowlist (or not on blocklist)
   */
  async thawPermissionless(
    mint: Address,
    tokenAccount: Address,
    tokenAccountOwner: Address,
    _feePayer: Address // TODO: Use when fee payment abstraction is complete
  ): Promise<MosaicTransactionResult> {
    const payer = await this.resolveFeePayerSigner();

    const fullTx = await getThawPermissionlessTransaction({
      rpc: this.rpc,
      payer,
      authority: this.signer,
      mint,
      tokenAccount,
      tokenAccountOwner,
    });

    return this.signAndSubmit(fullTx);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Management & Administration Operations
  // ═════════════════════════════════════════════════════════════════════════

  async prepareForceTransfer(options: {
    mint: Address;
    source: Address;
    destination: Address;
    amount: number;
    permanentDelegate: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const fullTx = await createForceTransferTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.destination,
      options.amount,
      createNoopSigner(options.permanentDelegate),
      createNoopSigner(options.feePayer)
    );

    return this.toMosaicTransaction(fullTx);
  }

  async forceTransfer(options: {
    mint: Address;
    source: Address;
    destination: Address;
    amount: number;
    permanentDelegate: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await createForceTransferTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.destination,
      options.amount,
      options.permanentDelegate,
      feePayer
    );

    return this.signAndSubmit(fullTx);
  }

  async prepareForceBurn(options: {
    mint: Address;
    source: Address;
    amount: number;
    permanentDelegate: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const fullTx = await createForceBurnTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.amount,
      createNoopSigner(options.permanentDelegate),
      createNoopSigner(options.feePayer)
    );

    return this.toMosaicTransaction(fullTx);
  }

  async forceBurn(options: {
    mint: Address;
    source: Address;
    amount: number;
    permanentDelegate: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx = await createForceBurnTransaction(
      this.rpc,
      options.mint,
      options.source,
      options.amount,
      options.permanentDelegate,
      feePayer
    );

    return this.signAndSubmit(fullTx);
  }

  async prepareUpdateAuthority(options: {
    mint: Address;
    role: Parameters<typeof getUpdateAuthorityTransaction>[0]["role"];
    currentAuthority: Address;
    newAuthority: Address | null;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const payer = createNoopSigner(options.feePayer);
    const currentAuthority = createNoopSigner(options.currentAuthority);

    const fullTx =
      options.newAuthority === null
        ? await getRemoveAuthorityTransaction({
            rpc: this.rpc,
            payer,
            mint: options.mint,
            role: options.role,
            currentAuthority,
          })
        : await getUpdateAuthorityTransaction({
            rpc: this.rpc,
            payer,
            mint: options.mint,
            role: options.role,
            currentAuthority,
            newAuthority: options.newAuthority,
          });

    return this.toMosaicTransaction(fullTx);
  }

  async updateAuthority(options: {
    mint: Address;
    role: Parameters<typeof getUpdateAuthorityTransaction>[0]["role"];
    currentAuthority: TransactionSigner;
    newAuthority: Address | null;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const fullTx =
      options.newAuthority === null
        ? await getRemoveAuthorityTransaction({
            rpc: this.rpc,
            payer: feePayer,
            mint: options.mint,
            role: options.role,
            currentAuthority: options.currentAuthority,
          })
        : await getUpdateAuthorityTransaction({
            rpc: this.rpc,
            payer: feePayer,
            mint: options.mint,
            role: options.role,
            currentAuthority: options.currentAuthority,
            newAuthority: options.newAuthority,
          });

    return this.signAndSubmit(fullTx);
  }

  async preparePauseToken(options: {
    mint: Address;
    pauseAuthority: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const { transactionMessage } = await createPauseTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: createNoopSigner(options.pauseAuthority),
      feePayer: createNoopSigner(options.feePayer),
    });

    return this.toMosaicTransaction(transactionMessage);
  }

  async pauseToken(options: {
    mint: Address;
    pauseAuthority: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const { transactionMessage } = await createPauseTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: options.pauseAuthority,
      feePayer,
    });

    return this.signAndSubmit(transactionMessage);
  }

  async prepareUnpauseToken(options: {
    mint: Address;
    pauseAuthority: Address;
    feePayer: Address;
  }): Promise<MosaicTransaction> {
    const { transactionMessage } = await createResumeTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: createNoopSigner(options.pauseAuthority),
      feePayer: createNoopSigner(options.feePayer),
    });

    return this.toMosaicTransaction(transactionMessage);
  }

  async unpauseToken(options: {
    mint: Address;
    pauseAuthority: TransactionSigner;
    feePayer: TransactionSigner;
  }): Promise<MosaicTransactionResult> {
    const feePayer = await this.resolveFeePayerSigner(options.feePayer);

    const { transactionMessage } = await createResumeTransaction(this.rpc, {
      mint: options.mint,
      pauseAuthority: options.pauseAuthority,
      feePayer,
    });

    return this.signAndSubmit(transactionMessage);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Custom Token Fallback (uses legacy Token2022Service)
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Create a custom token with manual extension configuration.
   * Falls back to Token2022Service for full control.
   */
  async createCustomToken(options: CreateTokenOptions): Promise<MosaicTransactionResult> {
    const { Token2022Service } = await import("@/services/solana/token-2022");
    const legacyService = new Token2022Service(this.env, this.signer, this.feePayment);

    const result = await legacyService.createMint({
      metadata: options.metadata,
      decimals: options.decimals,
      mintAuthority: options.mintAuthority,
      freezeAuthority: options.freezeAuthority,
      extensions: options.extensions,
    });

    return {
      signature: result.signature,
      slot: result.slot,
      mint: result.mint,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═════════════════════════════════════════════════════════════════════════

  private toMosaicTransaction(fullTx: FullTransaction, mint?: Address): MosaicTransaction {
    // Compile the message so signatures can be applied client-side.
    const compiled = compileTransaction(fullTx);
    const encoded = getBase64EncodedWireTransaction(compiled);
    const lifetimeConstraint = (
      fullTx as { lifetimeConstraint?: { blockhash: string; lastValidBlockHeight: bigint } }
    ).lifetimeConstraint;
    const blockhash = lifetimeConstraint?.blockhash ?? "";
    const lastValidBlockHeight = lifetimeConstraint?.lastValidBlockHeight ?? 0n;

    return {
      serializedTx: encoded,
      blockhash,
      lastValidBlockHeight,
      mint,
      requiredSigners: [],
    };
  }

  private async signAndSubmit(fullTx: FullTransaction): Promise<MosaicTransactionResult> {
    if (this.feePayment) {
      // Two-signer flow: custody signs locally, Kora adds fee payer + submits
      const partiallySignedTx = await partiallySignTransactionMessageWithSigners(fullTx);
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));

      const signature = await this.feePayment.signAndSend(txBytes);
      const confirmation = await confirmTransaction(this.rpc, signature);

      if (confirmation.err) {
        throw new Error(`Transaction failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // No fee sponsor configured: sign and submit directly
    const signedTx = await signTransactionMessageWithSigners(fullTx);
    const encoded = getBase64EncodedWireTransaction(signedTx);

    const signature = await this.rpc
      .sendTransaction(encoded, {
        skipPreflight: false,
        encoding: "base64",
      })
      .send();

    const confirmation = await confirmTransaction(this.rpc, signature);

    if (confirmation.err) {
      throw new Error(`Transaction failed: ${safeStringify(confirmation.err)}`);
    }

    return {
      signature,
      slot: confirmation.slot,
    };
  }

  private async signAndSubmitWithMintKeypair(
    fullTx: FullTransaction,
    _mintKeypair: TransactionSigner
  ): Promise<MosaicTransactionResult> {
    if (this.feePayment) {
      // Two-signer flow: transaction has signers attached, Kora adds fee payer
      const partiallySignedTx = await partiallySignTransactionMessageWithSigners(fullTx);
      const txEncoder = getTransactionEncoder();
      const txBytes = new Uint8Array(txEncoder.encode(partiallySignedTx));

      const signature = await this.feePayment.signAndSend(txBytes);
      const confirmation = await confirmTransaction(this.rpc, signature);

      if (confirmation.err) {
        throw new Error(`Transaction failed: ${safeStringify(confirmation.err)}`);
      }

      return {
        signature,
        slot: confirmation.slot,
      };
    }

    // Direct signing flow - signers are already attached to the transaction
    return this.signAndSubmit(fullTx);
  }

  private async resolveFeePayer(
    fallback: Address | TransactionSigner
  ): Promise<Address | TransactionSigner> {
    if (!this.feePayment) {
      return fallback;
    }

    const feePayer = await this.feePayment.getFeePayer();
    return createNoopSigner(feePayer);
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
}
