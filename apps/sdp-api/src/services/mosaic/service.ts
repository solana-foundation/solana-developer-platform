/**
 * Mosaic Service
 *
 * Template-based token issuance using @mosaic/sdk.
 * Replaces manual Token-2022 transaction building with Mosaic's
 * pre-configured templates and ABL integration.
 *
 * The SDK handles:
 * - Token-2022 extension configuration per template
 * - sRFC-37 Token ACL setup (freeze authority delegation)
 * - ABL (Allowlist/Blocklist) on-chain gating
 * - Decimal-aware amount conversion for minting
 */

import type { FeePaymentPort } from "@/services/ports/fee-payment.port";
import { confirmTransaction, createRpc } from "@/services/solana/rpc";
import type { Env } from "@/types/env";
import {
  // Types
  type FullTransaction,
  createArcadeTokenInitTransaction,
  // Token operations
  createMintToTransaction,
  // Template builders
  createCustomTokenInitTransaction,
  createStablecoinInitTransaction,
  createTokenizedSecurityInitTransaction,
  resolveTokenAccount,
  // ABL wallet management (object input pattern)
  getAddWalletTransaction,
  // Token ACL freeze/thaw (object input pattern)
  getFreezeTransaction,
  getRemoveWalletTransaction,
  getThawPermissionlessTransaction,
  getThawTransaction,
} from "@mosaic/sdk";
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  compileTransaction,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  signTransactionMessageWithSigners,
} from "@solana/kit";
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
    const enableSrfc37 =
      options.enableTokenAcl ?? options.enableAbl ?? options.template !== "custom";

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
    const enableSrfc37 =
      options.enableTokenAcl ?? options.enableAbl ?? options.template !== "custom";

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
        ? options.mintAuthority
        : options.mintAuthority.address;

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
          mintAuthorityAddress, // pausableAuthority
          mintAuthorityAddress, // confidentialBalancesAuthority
          mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          options.freezeAuthority ?? undefined
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
          mintAuthorityAddress, // pausableAuthority
          mintAuthorityAddress, // permanentDelegateAuthority
          enableSrfc37,
          options.freezeAuthority ?? undefined
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
          options.freezeAuthority ?? undefined,
          {
            aclMode,
            metadataAuthority: mintAuthorityAddress,
            pausableAuthority: mintAuthorityAddress,
            confidentialBalancesAuthority: mintAuthorityAddress,
            permanentDelegateAuthority: mintAuthorityAddress,
            enableSrfc37,
            scaledUiAmount: {
              authority: mintAuthorityAddress,
              multiplier: 1,
            },
          }
        );

      case "custom": {
        const extensions = options.extensions ?? {};
        const transferFee = extensions.transferFee;
        const interestBearing = extensions.interestBearing;
        const defaultAccountState = extensions.defaultAccountState;
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
            enableConfidentialBalances: extensions.confidentialTransfer === true,
            enableDefaultAccountState: !!defaultAccountState,
            defaultAccountStateInitialized:
              defaultAccountState !== undefined ? defaultAccountState !== "frozen" : undefined,
            enablePermanentDelegate: !!extensions.permanentDelegate,
            enableTransferFee: !!transferFee,
            transferFeeAuthority: transferFee?.transferFeeConfigAuthority,
            withdrawWithheldAuthority: transferFee?.withdrawWithheldAuthority,
            transferFeeBasisPoints: transferFee?.basisPoints,
            transferFeeMaximum: transferFee ? BigInt(transferFee.maxFee) : undefined,
            enableInterestBearing: !!interestBearing,
            interestBearingAuthority: interestBearing?.rateAuthority,
            interestRate: interestBearing?.rate,
            enableNonTransferable: extensions.nonTransferable === true,
            freezeAuthority: options.freezeAuthority ?? undefined,
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
    const feePayer = this.feePayment
      ? await this.feePayment.getFeePayer()
      : options.feePayer === this.signer.address
        ? this.signer
        : options.feePayer;

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
    const feePayer = this.feePayment
      ? await this.feePayment.getFeePayer()
      : options.feePayer === this.signer.address
        ? this.signer
        : options.feePayer;

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
    // TODO: Use computed payer when fee payment abstraction is complete
    const _payer = this.feePayment ? await this.feePayment.getFeePayer() : options.feePayer;

    // SDK uses object input pattern for ABL operations
    const fullTx = await getAddWalletTransaction({
      rpc: this.rpc,
      payer: this.signer, // payer must be a TransactionSigner
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
    // TODO: Use computed payer when fee payment abstraction is complete
    const _payer = this.feePayment ? await this.feePayment.getFeePayer() : options.feePayer;

    const fullTx = await getRemoveWalletTransaction({
      rpc: this.rpc,
      payer: this.signer,
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
    // SDK uses object input pattern - note: NO mint parameter!
    // The SDK fetches mint from the token account
    const fullTx = await getFreezeTransaction({
      rpc: this.rpc,
      payer: this.signer,
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
    const fullTx = await getThawTransaction({
      rpc: this.rpc,
      payer: this.signer,
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
    const fullTx = await getThawPermissionlessTransaction({
      rpc: this.rpc,
      payer: this.signer,
      authority: this.signer,
      mint,
      tokenAccount,
      tokenAccountOwner,
    });

    return this.signAndSubmit(fullTx);
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
    // Sign the transaction with all attached signers
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
}
